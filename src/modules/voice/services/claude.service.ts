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
   * Streams a response from Claude given conversation history.
   * If Claude decides to call the web_search tool, Tavily is invoked and
   * the result is fed back before streaming the final answer.
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

    try {
      // ── Step 1: non-streaming call so we can intercept tool use ────────────
      const tools = this.tavilyClient ? [WEB_SEARCH_TOOL] : undefined;

      const firstResponse = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages,
      });

      let inputTokens = firstResponse.usage.input_tokens;
      let outputTokens = firstResponse.usage.output_tokens;

      // ── Step 2: handle tool use if Claude requested a web search ───────────
      if (firstResponse.stop_reason === 'tool_use' && this.tavilyClient) {
        const toolUseBlock = firstResponse.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );

        if (toolUseBlock && toolUseBlock.name === 'web_search') {
          const query = (toolUseBlock.input as { query: string }).query;
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

          // Append assistant + tool_result to the message chain
          const messagesWithTool: Anthropic.MessageParam[] = [
            ...messages,
            { role: 'assistant', content: firstResponse.content },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUseBlock.id,
                  content: searchContent,
                },
              ],
            },
          ];

          // ── Step 3: stream the final answer after tool result ─────────────
          let fullText = '';
          const stream = this.client.messages.stream({
            model: this.model,
            max_tokens: 1024,
            system: systemPrompt,
            tools,
            messages: messagesWithTool,
          });

          for await (const event of stream) {
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

          callbacks.onDone(fullText, inputTokens, outputTokens);
          return;
        }
      }

      // ── No tool use — stream the direct response ────────────────────────
      // Re-run as a stream so the caller gets tokens progressively
      let fullText = '';
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const token = event.delta.text;
          fullText += token;
          callbacks.onToken(token);
        }
        if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens ?? 0;
        }
        if (event.type === 'message_start' && event.message.usage) {
          inputTokens = event.message.usage.input_tokens ?? 0;
        }
      }

      callbacks.onDone(fullText, inputTokens, outputTokens);
    } catch (error) {
      this.logger.error('Claude stream error:', error);
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Builds a system prompt based on user's professional field
   */
  buildSystemPrompt(fieldName?: string): string {
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
recent news, live data, or anything that may have changed after your training cutoff.`;

    if (fieldName) {
      return `${basePrompt}\n\nThe user is a professional in the field of: ${fieldName}.\nTailor your responses to be relevant to their professional context.`;
    }

    return basePrompt;
  }
}
