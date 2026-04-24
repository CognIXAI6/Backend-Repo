import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { tavily } from '@tavily/core';

export interface ClaudeStreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string, inputTokens: number, outputTokens: number) => void;
  onError: (error: Error) => void;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const WEB_SEARCH_TOOL: Anthropic.Tool = {
  name: 'web_search',
  description:
    'Search the web for real-time information about current events, recent news, live data, ' +
    'sports scores, stock prices, weather, or anything that may have changed after the AI training cutoff. ' +
    'Use this whenever the user asks about something that requires up-to-date information.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query to look up on the web.',
      },
    },
    required: ['query'],
  },
};

@Injectable()
export class ClaudeService implements OnModuleInit {
  private readonly logger = new Logger(ClaudeService.name);
  private client: Anthropic;
  private tavilyClient: ReturnType<typeof tavily> | null = null;
  private model: string;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.get<string>('voice.anthropicApiKey');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    this.client = new Anthropic({ apiKey });
    this.model = this.configService.get<string>('voice.claudeModel') ?? 'claude-sonnet-4-20250514';

    const tavilyApiKey = this.configService.get<string>('voice.tavilyApiKey');
    if (tavilyApiKey) {
      this.tavilyClient = tavily({ apiKey: tavilyApiKey });
      this.logger.log('Tavily web search enabled');
    } else {
      this.logger.warn('TAVILY_API_KEY not set — web search disabled');
    }

    this.logger.log(`Claude service initialized with model: ${this.model}`);
  }

  /**
   * Streams a response from Claude.
   *
   * Architecture: single streaming call from the start — no "probe" non-streaming
   * call. If Claude requests the web_search tool mid-stream, we collect the full
   * tool-use block, run Tavily, then make a second (non-streaming) follow-up call
   * and stream its result. The common case (no tool use) now only costs one round
   * trip instead of two.
   *
   * The system prompt is marked with cache_control so Anthropic caches the
   * processed prompt for 5 minutes — subsequent calls within that window skip
   * prompt tokenization entirely, cutting ~200-400ms per request.
   */
  async streamResponse(
    userMessage: string,
    history: ConversationTurn[],
    systemPrompt: string,
    callbacks: ClaudeStreamCallbacks,
  ): Promise<void> {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((turn) => ({
        role: turn.role as 'user' | 'assistant',
        content: turn.content,
      })),
      { role: 'user', content: userMessage },
    ];

    // Cache the system prompt — saves ~200-400ms on every repeat call within 5 min
    const systemWithCache: Anthropic.TextBlockParam[] = [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];

    const tools = this.tavilyClient ? [WEB_SEARCH_TOOL] : undefined;

    try {
      // ── Single streaming call — stream from the very start ─────────────────
      let fullText = '';
      let inputTokens = 0;
      let outputTokens = 0;

      // Accumulate tool-use block if Claude decides to call web_search
      let toolUseId: string | null = null;
      let toolName: string | null = null;
      let toolInputJson = '';
      let inToolUse = false;

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 1024,
        system: systemWithCache,
        tools,
        messages,
      });

      for await (const event of stream) {
        if (event.type === 'message_start' && event.message.usage) {
          inputTokens = event.message.usage.input_tokens ?? 0;
        }

        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            inToolUse = true;
            toolUseId = event.content_block.id;
            toolName = event.content_block.name;
            toolInputJson = '';
          } else {
            inToolUse = false;
          }
        }

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta' && !inToolUse) {
            const token = event.delta.text;
            fullText += token;
            callbacks.onToken(token);
          } else if (event.delta.type === 'input_json_delta') {
            toolInputJson += event.delta.partial_json;
          }
        }

        if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens ?? 0;
        }
      }

      const finalMessage = await stream.finalMessage();

      // ── Tool use requested — run Tavily then stream the follow-up ──────────
      if (
        finalMessage.stop_reason === 'tool_use' &&
        toolUseId &&
        toolName === 'web_search' &&
        this.tavilyClient
      ) {
        let query = '';
        try {
          query = (JSON.parse(toolInputJson) as { query: string }).query;
        } catch {
          query = userMessage;
        }

        this.logger.log(`Web search triggered: "${query}"`);

        let searchContent = '';
        try {
          const searchResult = await this.tavilyClient.search(query, {
            searchDepth: 'basic',
            maxResults: 5,
          });
          searchContent = searchResult.results
            .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\nSource: ${r.url}`)
            .join('\n\n');
        } catch (searchErr) {
          this.logger.error('Tavily search error:', searchErr);
          searchContent = 'Search failed — please answer based on your training knowledge.';
        }

        const messagesWithTool: Anthropic.MessageParam[] = [
          ...messages,
          { role: 'assistant', content: finalMessage.content },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: searchContent,
              },
            ],
          },
        ];

        // Stream the final answer after the tool result
        fullText = '';
        const followUpStream = this.client.messages.stream({
          model: this.model,
          max_tokens: 1024,
          system: systemWithCache,
          tools,
          messages: messagesWithTool,
        });

        for await (const event of followUpStream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const token = event.delta.text;
            fullText += token;
            callbacks.onToken(token);
          }
          if (event.type === 'message_delta' && event.usage) {
            outputTokens += event.usage.output_tokens ?? 0;
          }
          if (event.type === 'message_start' && event.message.usage) {
            inputTokens += event.message.usage.input_tokens ?? 0;
          }
        }
      }

      callbacks.onDone(fullText, inputTokens, outputTokens);
    } catch (error) {
      this.logger.error('Claude stream error:', error);
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Builds a system prompt based on user's professional field.
   */
  buildSystemPrompt(fieldName?: string, aiMemory?: string): string {
    const now = new Date();
    const currentDate = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const currentTime = now.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    const basePrompt = `You are CognIX AI, an intelligent assistant for professionals.
You receive voice transcriptions and provide helpful, concise, actionable responses.
Keep responses conversational and clear — they will be read or spoken back to the user.
Be direct and avoid unnecessary filler phrases.

Today's date and time: ${currentDate}, ${currentTime}.
Always use this date as ground truth when asked about the current date, time, day, or year.

You have access to a web_search tool. Use it whenever the user asks about current events,
recent news, live data, or anything that may have changed after your training cutoff.
When web_search returns results, include the source URLs as markdown links — do not repeat the full article content.

## Response format for external references
When your response references external content (articles, documents, verses, papers, cases, etc.):
- Give a 1–2 sentence insight or teaser about it
- Provide a markdown link: [Read more](URL) or [View source](URL)
- Never quote the full content inline — link to it instead
- If multiple references, list each with its own link on a new line`;

    const memoryBlock = aiMemory
      ? `\n\n## What you remember about this user from past sessions\n${aiMemory}`
      : '';

    const fieldContext = fieldName
      ? `\n\nThe user is a professional in the field of: ${fieldName}.
Tailor your responses to be relevant to their professional context.

## Field relevance gate — STRICTLY ENFORCE
Only respond to messages that are relevant to the field of "${fieldName}" or general professional productivity (scheduling, summarising, research, communication).
If the user's message is clearly outside that field, do NOT answer it. Instead, respond with exactly:
"That's outside your selected field (${fieldName}). I'm here to help with topics relevant to your profession. Try asking something related to ${fieldName}."
Do not add anything else when rejecting — just that message.

${this.getFieldLinkGuide(fieldName)}`
      : '';

    return basePrompt + fieldContext + memoryBlock;
  }

  private getFieldLinkGuide(fieldName: string): string {
    const field = fieldName.toLowerCase();

    if (this.matchesField(field, ['pastor', 'theology', 'church', 'ministry', 'christian', 'bible', 'religion', 'faith'])) {
      return `## Bible & theology links
When referencing Bible verses or passages, always link to Bible Gateway using this URL pattern:
  https://www.biblegateway.com/passage/?search=BOOK+CHAPTER:VERSE&version=NIV
Example: John 3:16 → [Read John 3:16](https://www.biblegateway.com/passage/?search=John+3:16&version=NIV)
For commentaries or study resources, link to Blue Letter Bible: https://www.blueletterbible.org/
Never quote an entire passage — give the key thought and link to the full text.`;
    }

    if (this.matchesField(field, ['doctor', 'physician', 'medical', 'medicine', 'healthcare', 'nurse', 'clinical'])) {
      return `## Medical reference links
When referencing clinical studies, drug info, or guidelines, prefer these sources:
- PubMed: https://pubmed.ncbi.nlm.nih.gov/?term=SEARCH_TERM
- MedlinePlus: https://medlineplus.gov/
- NIH: https://www.nih.gov/
Always link to the source rather than reproducing clinical data inline.`;
    }

    if (this.matchesField(field, ['lawyer', 'attorney', 'legal', 'law', 'counsel', 'barrister', 'solicitor'])) {
      return `## Legal reference links
When referencing statutes, case law, or regulations, prefer these sources:
- Cornell Law (US): https://www.law.cornell.edu/
- Justia: https://law.justia.com/
- Google Scholar (cases): https://scholar.google.com/
Cite the case or statute name, provide a link, and give a 1-sentence summary — do not reproduce full rulings.`;
    }

    if (this.matchesField(field, ['developer', 'engineer', 'software', 'programmer', 'coding', 'tech'])) {
      return `## Technical reference links
When referencing documentation, packages, or specs, prefer official docs:
- MDN: https://developer.mozilla.org/
- npm: https://www.npmjs.com/package/PACKAGE_NAME
- GitHub: https://github.com/
Link to the relevant doc page rather than pasting code blocks unless the user explicitly asks for code.`;
    }

    if (this.matchesField(field, ['finance', 'accountant', 'investment', 'trading', 'economist', 'banking'])) {
      return `## Finance reference links
When referencing financial data, reports, or regulations:
- SEC filings: https://www.sec.gov/cgi-bin/browse-edgar
- Investopedia: https://www.investopedia.com/
- Yahoo Finance: https://finance.yahoo.com/quote/TICKER
Link to data sources rather than reproducing figures inline.`;
    }

    return `## Reference links
When your answer references an external source, article, or document, provide a markdown link
so the user can read the full content directly. Keep your response to a short insight + link.`;
  }

  private matchesField(field: string, keywords: string[]): boolean {
    return keywords.some((kw) => field.includes(kw));
  }

  buildDualSpeakerPrompt(fieldName?: string, aiMemory?: string): string {
    const now = new Date();
    const currentDate = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const currentTime = now.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    const memoryBlock = aiMemory
      ? `\n\n## What you know about the owner from past sessions\n${aiMemory}`
      : '';

    const fieldBlock = fieldName
      ? `\nThe owner is a professional in the field of: ${fieldName}. Tailor all insights to that context.`
      : '';

    return `You are CognIX AI, a real-time conversation assistant helping a professional during a live conversation.

Today is ${currentDate}, ${currentTime}.

## Your role
You listen to a two-person conversation. You are given:
- The full conversation history labeled as [Owner] and [Other Person]
- The latest thing the other person just said

Your job is to give the OWNER a brief, actionable insight — something they should know, consider, or say next based on what the other person said and the context of the full conversation.

## Response rules
- Keep your insight SHORT — 2 to 4 sentences maximum
- Address the owner directly ("You should...", "They seem to...", "Consider asking...")
- Do NOT repeat what was said — get straight to the insight
- If the other person referenced something with a known URL (Bible verse, article, legal case, etc.), include a markdown link instead of quoting it in full
- If there is nothing meaningful to add, respond with: "Nothing to flag — keep going."
${fieldBlock}${memoryBlock}`;
  }

  async summarizeConversationForMemory(
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    existingMemory: string | null,
    fieldName?: string,
  ): Promise<string> {
    const historyText = conversationHistory
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const prompt = existingMemory
      ? `You have an existing memory summary about this user:\n${existingMemory}\n\nHere is their latest conversation:\n${historyText}\n\nUpdate the memory summary to incorporate new key facts. Keep it concise (under 200 words). Focus on: preferences, recurring topics, names mentioned, decisions made, professional context.`
      : `Summarize the key facts from this conversation to remember for future sessions. Keep it under 150 words. Focus on: preferences, recurring topics, names mentioned, decisions made, professional context.\n\nConversation:\n${historyText}`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 300,
      system: `You are a memory system for an AI assistant${fieldName ? ` serving a ${fieldName} professional` : ''}. Extract only facts worth remembering long-term. Be concise.`,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    return block.type === 'text' ? block.text : '';
  }
}
