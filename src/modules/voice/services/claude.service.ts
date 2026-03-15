import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

export interface ClaudeStreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string, inputTokens: number, outputTokens: number) => void;
  onError: (error: Error) => void;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

@Injectable()
export class ClaudeService implements OnModuleInit {
  private readonly logger = new Logger(ClaudeService.name);
  private client: Anthropic;
  private model: string;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.get<string>('voice.anthropicApiKey');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    this.client = new Anthropic({ apiKey });
    this.model = this.configService.get<string>('voice.claudeModel') ?? 'claude-sonnet-4-20250514';
    this.logger.log(`Claude service initialized with model: ${this.model}`);
  }

  /**
   * Streams a response from Claude given conversation history.
   * Calls callbacks as tokens arrive.
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
      let fullText = '';
      let inputTokens = 0;
      let outputTokens = 0;

      const stream = await this.client.messages.stream({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
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
    const basePrompt = `You are CognIX AI, an intelligent assistant for professionals. 
You receive voice transcriptions and provide helpful, concise, actionable responses.
Keep responses conversational and clear — they will be read or spoken back to the user.
Be direct and avoid unnecessary filler phrases.`;

    if (fieldName) {
      return `${basePrompt}\n\nThe user is a professional in the field of: ${fieldName}. 
Tailor your responses to be relevant to their professional context.`;
    }

    return basePrompt;
  }
}