import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { tavily } from '@tavily/core';

export interface ClaudeStreamCallbacks {
  onToken: (token: string) => void;
  // Declared as Promise<void> so callers can do async work (DB saves, etc.)
  // and errors inside onDone propagate to onError instead of becoming silent
  // unhandled rejections that leave the session in a broken state.
  onDone: (fullText: string, inputTokens: number, outputTokens: number) => Promise<void> | void;
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
    this.model = this.configService.get<string>('voice.claudeModel') ?? 'claude-sonnet-4-6';

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
    options: { enableWebSearch?: boolean } = {},
  ): Promise<void> {
    // Sanitize history: if content is somehow an array (defensive against DB edge cases),
    // flatten to text-only so no tool_use blocks leak into the messages array.
    const messages: Anthropic.MessageParam[] = [
      ...history.map((turn) => {
        const c = turn.content as unknown;
        if (Array.isArray(c)) {
          const text = (c as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('') || '…';
          return { role: turn.role as 'user' | 'assistant', content: text };
        }
        return { role: turn.role as 'user' | 'assistant', content: String(c) };
      }),
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

    // Voice mode disables tools — web search adds 500ms–2s and is incompatible
    // with real-time voice. Text mode keeps tools for current-events queries.
    const tools =
      options.enableWebSearch !== false && this.tavilyClient ? [WEB_SEARCH_TOOL] : undefined;

    try {
      // ── Single streaming call — stream from the very start ─────────────────
      let fullText = '';
      let inputTokens = 0;
      let outputTokens = 0;

      // Collect ALL tool-use blocks Claude may emit in a single response.
      // A single response can contain multiple tool_use blocks; only capturing
      // the last one (as the old code did) leaves earlier ones without a
      // matching tool_result, which causes a 400 from the Anthropic API.
      interface PendingToolCall { id: string; name: string; inputJson: string }
      const collectedToolCalls: PendingToolCall[] = [];
      let activeToolCall: PendingToolCall | null = null;

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 300,
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
            // Flush any previous tool call that was open (shouldn't happen, but safe)
            if (activeToolCall) collectedToolCalls.push(activeToolCall);
            activeToolCall = { id: event.content_block.id, name: event.content_block.name, inputJson: '' };
          } else {
            if (activeToolCall) { collectedToolCalls.push(activeToolCall); activeToolCall = null; }
          }
        }

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta' && !activeToolCall) {
            const token = event.delta.text;
            fullText += token;
            callbacks.onToken(token);
          } else if (event.delta.type === 'input_json_delta' && activeToolCall) {
            activeToolCall.inputJson += event.delta.partial_json;
          }
        }

        if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens ?? 0;
        }
      }

      // Flush any still-open tool call after the stream ends
      if (activeToolCall) { collectedToolCalls.push(activeToolCall); activeToolCall = null; }

      const finalMessage = await stream.finalMessage();

      // ── Tool use requested — run ALL Tavily searches then stream the follow-up ─
      // Claude can emit multiple tool_use blocks in one response. We collect them
      // all above and must provide a tool_result for EACH one; missing any causes
      // a 400 "tool_use without tool_result" error from the Anthropic API.
      const webSearchCalls = collectedToolCalls.filter(
        (tc) => tc.name === 'web_search' && this.tavilyClient,
      );

      if (finalMessage.stop_reason === 'tool_use' && webSearchCalls.length > 0) {
        this.logger.log(`Web search triggered (${webSearchCalls.length} call(s))`);

        // Run all searches in parallel to keep latency low
        const toolResults = await Promise.all(
          webSearchCalls.map(async (tc) => {
            let query = userMessage;
            try { query = (JSON.parse(tc.inputJson) as { query: string }).query; } catch {}

            this.logger.log(`  → searching: "${query}"`);

            let content = 'Search failed — please answer based on your training knowledge.';
            try {
              const r = await this.tavilyClient!.search(query, { searchDepth: 'basic', maxResults: 5 });
              content = r.results
                .map((res, i) => `[${i + 1}] ${res.title}\n${res.content}\nSource: ${res.url}`)
                .join('\n\n');
            } catch (err) {
              this.logger.error(`Tavily search error for "${query}":`, err);
            }

            return { type: 'tool_result' as const, tool_use_id: tc.id, content };
          }),
        );

        const messagesWithTool: Anthropic.MessageParam[] = [
          ...messages,
          { role: 'assistant', content: finalMessage.content },
          // Single user message with ALL tool_results — one per tool_use block
          { role: 'user', content: toolResults },
        ];

        // Stream the final answer — disable tools on follow-up to avoid recursion
        fullText = '';
        const followUpStream = this.client.messages.stream({
          model: this.model,
          max_tokens: 300,
          system: systemWithCache,
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

      await callbacks.onDone(fullText, inputTokens, outputTokens);
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

    const basePrompt = `You are CognIX AI, a real-time insight assistant for professionals.

Today's date and time: ${currentDate}, ${currentTime}.
Always use this date as ground truth when asked about the current date, time, day, or year.

## RESPONSE FORMAT — STRICTLY FOLLOW THIS
- Always respond in SHORT BULLET POINTS — maximum 4 bullets
- Each bullet: one concise sentence, max 15 words
- No introductions, no conclusions, no filler phrases
- No paragraphs — bullets only
- If referencing a verse, article, or document: one bullet with a markdown link [Title](URL), no quoting

## WRONG (never do this):
"You're touching on one of the most profound truths in theology — the incomprehensibility of God. No matter how much we study..."

## RIGHT (always do this):
- God's knowledge is infinite; human understanding has limits — Isaiah 55:8-9
- This mystery should deepen worship, not cause doubt
- [Read Isaiah 55:8-9](https://www.biblegateway.com/passage/?search=Isaiah+55:8-9&version=NIV)

You have access to a web_search tool. Use it for current events, live data, or anything after your training cutoff.
When search results are used, include the source as a bullet with a markdown link — no full article content.`;

    const memoryBlock = aiMemory
      ? `\n\n## What you remember about this user from past sessions\n${aiMemory}`
      : '';

    const fieldContext = fieldName
      ? `\n\nThe user is a professional in the field of: ${fieldName}.
Tailor your responses to be relevant to their professional context.

## Field relevance guidance
Your primary focus is helping this user with topics relevant to "${fieldName}" and adjacent professional areas.
${this.getFieldBreadthNote(fieldName)}

Only decline a request if it is clearly recreational or personal with zero professional relevance (e.g. movie recommendations, sports gossip, personal relationships). In that case respond with:
"I'm focused on helping you professionally. Try asking something related to your work or industry."

When in doubt — answer. A Business professional asking about engineering, construction, law, or finance is almost certainly asking in a professional context. Adjacency to their field is not a reason to decline.

${this.getFieldLinkGuide(fieldName)}`
      : '';

    return basePrompt + fieldContext + memoryBlock;
  }

  private getFieldBreadthNote(fieldName: string): string {
    const field = fieldName.toLowerCase();

    if (this.matchesField(field, ['business', 'entrepreneur', 'startup', 'executive', 'management', 'ceo', 'coo', 'cfo'])) {
      return 'Business is a broad field. Topics like engineering, construction, finance, law, HR, supply chain, real estate, technology, and any industry vertical are ALL within scope — a business professional operates across all of them.';
    }

    if (this.matchesField(field, ['doctor', 'physician', 'medical', 'medicine', 'healthcare', 'nurse', 'clinical'])) {
      return 'Healthcare professionals routinely deal with pharmacology, research, administration, insurance, and patient communication — all are in scope.';
    }

    if (this.matchesField(field, ['lawyer', 'attorney', 'legal', 'law', 'counsel', 'barrister', 'solicitor'])) {
      return 'Legal professionals work across many domains — contracts, real estate, corporate, criminal, family, tax. Any of these are in scope.';
    }

    if (this.matchesField(field, ['pastor', 'theology', 'church', 'ministry', 'christian', 'bible', 'religion', 'faith'])) {
      return 'Ministry work involves theology, counselling, community management, finance, and communications. All are in scope.';
    }

    if (this.matchesField(field, ['developer', 'engineer', 'software', 'programmer', 'coding', 'tech'])) {
      return 'Engineering and tech professionals often need help with architecture, DevOps, project management, security, and business requirements — all in scope.';
    }

    return `Adjacent professional topics, research, and productivity tasks related to ${fieldName} are all in scope.`;
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
You listen to a two-person conversation labeled [Owner] and [Other Person].
Your job: give the OWNER a brief, actionable insight based on what the other person just said.

## RESPONSE FORMAT — STRICTLY FOLLOW THIS
- Always respond in SHORT BULLET POINTS — maximum 4 bullets
- Each bullet: one concise sentence, max 15 words
- Address the owner directly ("You should...", "They seem to...", "Consider asking...")
- No introductions, no conclusions, no paragraphs — bullets only
- Do NOT repeat what was said — get straight to the insight
- If referencing a verse, article, or document: one bullet with a markdown link [Title](URL), no quoting
- If there is nothing meaningful to add, respond with a single bullet: "Nothing to flag — keep going."

## WRONG (never do this):
"Based on what they said, it seems like they're struggling with the concept of faith and doubt, which is actually a very common theological tension that many believers face throughout their journey..."

## RIGHT (always do this):
- They're questioning the tension between faith and doubt — a normal spiritual phase
- Validate their honesty; doubt can deepen genuine faith
- [Read Mark 9:24 — "I believe; help my unbelief"](https://www.biblegateway.com/passage/?search=Mark+9:24&version=NIV)
${fieldBlock}${memoryBlock}`;
  }

  /**
   * Generates a short, descriptive conversation title (4–7 words) from the
   * first user prompt and the first AI insight. Called once after the first
   * AI response, fire-and-forget.
   */
  async generateConversationTitle(
    userPrompt: string,
    aiResponse: string,
    fieldName?: string,
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001', // fast + cheap for a title
      max_tokens: 20,
      system: 'You generate short conversation titles. Output ONLY the title — no quotes, no explanation, no punctuation at the end. Max 7 words.',
      messages: [
        {
          role: 'user',
          content: `Generate a title for this conversation${fieldName ? ` (context: ${fieldName})` : ''}.\nUser said: "${userPrompt.slice(0, 200)}"\nAI responded about: "${aiResponse.slice(0, 200)}"`,
        },
      ],
    });
    const block = response.content[0];
    return block.type === 'text' ? block.text.trim() : userPrompt.slice(0, 50);
  }

  /**
   * Fast topic-relevance gate. Returns true if the utterance is relevant to the
   * ongoing AI conversation, false if it is clearly off-topic ambient speech
   * (e.g. narrating a movie to someone else, unrelated social chatter).
   *
   * Uses Haiku with max_tokens:1 so cost and latency are negligible (~200-400ms).
   * Defaults to true on any error so the filter never silently blocks real input.
   */
  async checkTopicRelevance(
    transcript: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    fieldName?: string,
  ): Promise<boolean> {
    const context = history
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content.slice(0, 120)}`)
      .join('\n');

    const fieldLine = fieldName
      ? `The AI assistant specialises in ${fieldName}, but it can and should help with questions from ANY domain — a counsellor helps with education, relationships, career, health, and more; a doctor may discuss lifestyle or mental health; a lawyer may discuss finance. Topic changes are always allowed.\n\n`
      : '';

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        system:
          `${fieldLine}` +
          'You are an ambient-speech filter for a voice AI assistant. ' +
          'Your ONLY job is to detect whether the user is addressing the AI or not. ' +
          'Reply N ONLY if the utterance is clearly ambient speech directed at a third person ' +
          '(e.g. narrating events to someone else in the room, chatting with a colleague, ' +
          'talking on a separate phone call). ' +
          'Reply Y for ANY genuine question, statement, or topic change directed at the AI — ' +
          'even if it seems unrelated to the recent conversation. ' +
          'When in doubt, reply Y.',
        messages: [
          {
            role: 'user',
            content: `Conversation:\n${context}\n\nNew utterance: "${transcript.slice(0, 200)}"\n\nIs the user addressing the AI?`,
          },
        ],
      });
      return (response.content[0] as Anthropic.TextBlock)?.text?.trim().toUpperCase() !== 'N';
    } catch {
      return true; // fail open — never silently block real input
    }
  }

  async summarizeConversationForMemory(
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    existingMemory: string | null,
    fieldName?: string,
  ): Promise<string> {
    const historyText = conversationHistory
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const FORMAT_RULES = `Output ONLY a bullet list. Max 6 bullets. Each bullet: one short sentence (≤15 words).
Cover only: names of people/companies mentioned, key decisions made, recurring topics, stated preferences or goals.
Omit anything vague, obvious, or that won't help in a future conversation.
No intro sentence. No headers. Just bullets.`;

    const prompt = existingMemory
      ? `Existing memory:\n${existingMemory}\n\nNew conversation:\n${historyText}\n\nMerge into an updated bullet list. Remove outdated or contradicted facts. Add new ones. ${FORMAT_RULES}`
      : `Conversation:\n${historyText}\n\nExtract facts worth remembering. ${FORMAT_RULES}`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 200,
      system: `You are a memory system for an AI assistant${fieldName ? ` serving a ${fieldName} professional` : ''}. Extract only concrete facts useful in future conversations. Be extremely concise.`,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    return block.type === 'text' ? block.text : '';
  }
}
