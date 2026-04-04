import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { EventEmitter } from 'events';

import { DeepgramService } from './services/deepgram.service';
import { ClaudeService } from './services/claude.service';
import { ConversationService, ConversationMode } from './services/conversation.service';
import { GuestSessionService } from './services/guest-session.service';

// ─── Per-socket session state ─────────────────────────────────────────────────

interface ActiveSession {
  /** Authenticated user id OR the guest session UUID (used as pseudo user-id) */
  userId: string;
  conversationId: string;
  fieldName?: string;
  isGuest: boolean;
  /** Only set for guest sessions */
  guestSessionId?: string;
  deepgramEmitter: EventEmitter;
  sendAudio: (chunk: Buffer) => void;
  closeDeepgram: () => void;
  accumulatedTranscript: string;
  isProcessingAI: boolean;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

@WebSocketGateway({
  namespace: '/voice',
  cors: { origin: '*', credentials: true },
})
export class VoiceGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(VoiceGateway.name);
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(
    private readonly deepgramService: DeepgramService,
    private readonly claudeService: ClaudeService,
    private readonly conversationService: ConversationService,
    private readonly guestSessionService: GuestSessionService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  afterInit(): void {
    this.logger.log('🎙️  VoiceGateway live at ws://…/voice');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.cleanupSession(client.id);
  }

  // ─── session:start ──────────────────────────────────────────────────────────
  /**
   * Starts a voice session.
   *
   * Authenticated:  pass `accessToken` (JWT).
   * Guest:          pass `guestSessionId` (UUID stored in client localStorage).
   *
   * The backend validates which path to take based on what is present.
   */
  @SubscribeMessage('session:start')
  async handleSessionStart(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      /** JWT access token for authenticated users */
      accessToken?: string;
      /** UUID stored in localStorage for guest users */
      guestSessionId?: string;
      conversationId?: string;
      mode?: ConversationMode;
      fieldId?: string;
      fieldName?: string;
    },
  ): Promise<void> {
    try {
      this.cleanupSession(client.id);

      // ── Resolve identity ──────────────────────────────────────────────────
      let userId: string;
      let isGuest: boolean;
      let guestSessionId: string | undefined;

      if (payload.accessToken) {
        // Authenticated path — verify JWT
        try {
          const decoded = this.jwtService.verify<{ sub: string }>(payload.accessToken, {
            secret: this.configService.get<string>('jwt.secret'),
          });
          userId = decoded.sub;
          isGuest = false;
        } catch {
          client.emit('error', { code: 'INVALID_TOKEN', message: 'Access token is invalid or expired' });
          return;
        }
      } else if (payload.guestSessionId) {
        // Guest path — use guestSessionId as pseudo userId
        guestSessionId = payload.guestSessionId;
        userId = guestSessionId; // conversations store this UUID as user_id

        const canSend = await this.guestSessionService.canSendPrompt(guestSessionId);
        const status = await this.guestSessionService.getPromptStatus(guestSessionId);

        isGuest = true;

        // Emit current prompt status so the frontend can show the counter
        client.emit('guest:status', {
          used: status.used,
          limit: status.limit,
          remaining: status.remaining,
        });

        if (!canSend) {
          client.emit('guest:limit_reached', {
            message: 'You have used all 5 free prompts. Sign up to continue.',
            used: status.used,
            limit: status.limit,
          });
          return;
        }
      } else {
        client.emit('error', { code: 'AUTH_REQUIRED', message: 'Provide accessToken or guestSessionId' });
        return;
      }

      // ── Create or resume conversation ─────────────────────────────────────
      let conversationId = payload.conversationId;
      if (!conversationId) {
        const conv = await this.conversationService.createConversation(
          userId,
          payload.mode ?? 'single',
          payload.fieldId,
        );
        conversationId = conv.id;
      }

      // ── Open Deepgram live session ────────────────────────────────────────
      const { emitter, sendAudio, close } = await this.deepgramService.createLiveSession(client.id);

      const session: ActiveSession = {
        userId,
        conversationId,
        fieldName: payload.fieldName,
        isGuest,
        guestSessionId,
        deepgramEmitter: emitter,
        sendAudio,
        closeDeepgram: close,
        accumulatedTranscript: '',
        isProcessingAI: false,
      };

      // Forward Deepgram transcript events → client
      emitter.on('transcript', (result) => {
        if (result.isFinal) {
          session.accumulatedTranscript =
            (session.accumulatedTranscript + ' ' + result.transcript).trim();
        }

        client.emit('transcript:update', {
          transcript: result.isFinal
            ? session.accumulatedTranscript
            : (session.accumulatedTranscript + ' ' + result.transcript).trim(),
          isFinal: result.isFinal,
          confidence: result.confidence,
        });
      });

      emitter.on('error', (err: Error) => {
        client.emit('error', { code: 'DEEPGRAM_ERROR', message: err.message });
      });

      this.sessions.set(client.id, session);

      client.emit('session:ready', {
        conversationId,
        isGuest,
        message: 'Session ready. Start speaking or type a message.',
      });

      this.logger.log(
        `Session started — user: ${userId} (${isGuest ? 'guest' : 'auth'}), conv: ${conversationId}`,
      );
    } catch (err) {
      this.logger.error('session:start failed', err);
      client.emit('error', { code: 'SESSION_START_FAILED', message: (err as Error).message });
    }
  }

  // ─── audio:chunk ────────────────────────────────────────────────────────────
  @SubscribeMessage('audio:chunk')
  handleAudioChunk(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { chunk: ArrayBuffer | Buffer },
  ): void {
    const session = this.sessions.get(client.id);
    if (!session) {
      client.emit('error', { code: 'NO_SESSION', message: 'Call session:start first' });
      return;
    }

    const buffer = Buffer.isBuffer(payload.chunk)
      ? payload.chunk
      : Buffer.from(payload.chunk);

    session.sendAudio(buffer);
  }

  // ─── audio:stop ─────────────────────────────────────────────────────────────
  /**
   * User releases mic → check guest limit, then send accumulated transcript to Claude.
   */
  @SubscribeMessage('audio:stop')
  async handleAudioStop(@ConnectedSocket() client: Socket): Promise<void> {
    const session = this.sessions.get(client.id);
    if (!session) return;

    const transcript = session.accumulatedTranscript.trim();

    if (!transcript) {
      client.emit('ai:skipped', { reason: 'empty_transcript' });
      return;
    }

    if (session.isProcessingAI) {
      client.emit('ai:skipped', { reason: 'already_processing' });
      return;
    }

    // ── Guest prompt limit check ───────────────────────────────────────────
    if (session.isGuest && session.guestSessionId) {
      const canSend = await this.guestSessionService.canSendPrompt(session.guestSessionId);
      if (!canSend) {
        const status = await this.guestSessionService.getPromptStatus(session.guestSessionId);
        client.emit('guest:limit_reached', {
          message: 'You have used all 5 free prompts. Sign up to continue.',
          used: status.used,
          limit: status.limit,
        });
        return;
      }
    }

    session.accumulatedTranscript = '';
    await this.processPrompt(client, session, transcript, 'voice');
  }

  // ─── text:send ──────────────────────────────────────────────────────────────
  /**
   * User types a text prompt — skip Deepgram, send directly to Claude.
   */
  @SubscribeMessage('text:send')
  async handleTextSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { text: string },
  ): Promise<void> {
    const session = this.sessions.get(client.id);
    if (!session) {
      client.emit('error', { code: 'NO_SESSION', message: 'Call session:start first' });
      return;
    }

    const text = (payload.text ?? '').trim();
    if (!text) {
      client.emit('ai:skipped', { reason: 'empty_text' });
      return;
    }

    if (session.isProcessingAI) {
      client.emit('ai:skipped', { reason: 'already_processing' });
      return;
    }

    // ── Guest prompt limit check ───────────────────────────────────────────
    if (session.isGuest && session.guestSessionId) {
      const canSend = await this.guestSessionService.canSendPrompt(session.guestSessionId);
      if (!canSend) {
        const status = await this.guestSessionService.getPromptStatus(session.guestSessionId);
        client.emit('guest:limit_reached', {
          message: 'You have used all 5 free prompts. Sign up to continue.',
          used: status.used,
          limit: status.limit,
        });
        return;
      }
    }

    await this.processPrompt(client, session, text, 'text');
  }

  // ─── session:end ─────────────────────────────────────────────────────────────
  @SubscribeMessage('session:end')
  handleSessionEnd(@ConnectedSocket() client: Socket): void {
    this.cleanupSession(client.id);
    client.emit('session:ended');
  }

  // ─── Core prompt processing (shared by voice and text paths) ─────────────────
  private async processPrompt(
    client: Socket,
    session: ActiveSession,
    userMessage: string,
    inputType: 'voice' | 'text',
  ): Promise<void> {
    session.isProcessingAI = true;
    const aiStartTime = Date.now();

    try {
      // 1. Persist user message
      await this.conversationService.saveMessage({
        conversationId: session.conversationId,
        role: 'user',
        content: userMessage,
        transcript: inputType === 'voice' ? userMessage : undefined,
      });

      client.emit('transcript:confirmed', { transcript: userMessage, inputType });
      client.emit('ai:start');

      // 2. Load conversation history for Claude context
      const history = await this.conversationService.getConversationHistory(
        session.conversationId,
        session.userId,
      );
      const historyWithoutCurrent = history.slice(0, -1);
      const systemPrompt = this.claudeService.buildSystemPrompt(session.fieldName);

      let firstToken = true;

      // 3. Stream Claude response
      await this.claudeService.streamResponse(
        userMessage,
        historyWithoutCurrent,
        systemPrompt,
        {
          onToken: (token: string) => {
            if (firstToken) {
              client.emit('ai:latency', { latencyMs: Date.now() - aiStartTime });
              firstToken = false;
            }
            client.emit('ai:token', { token });
          },

          onDone: async (fullText: string, inputTokens: number, outputTokens: number) => {
            // 4. Persist assistant message
            await this.conversationService.saveMessage({
              conversationId: session.conversationId,
              role: 'assistant',
              content: fullText,
              tokensUsed: inputTokens + outputTokens,
              latencyMs: Date.now() - aiStartTime,
            });

            // 5. Increment guest prompt count and emit updated status
            if (session.isGuest && session.guestSessionId) {
              const updated = await this.guestSessionService.incrementPromptCount(session.guestSessionId);
              const remaining = Math.max(0, updated.prompt_limit - updated.prompt_count);
              client.emit('guest:status', {
                used: updated.prompt_count,
                limit: updated.prompt_limit,
                remaining,
              });
              if (remaining === 0) {
                client.emit('guest:limit_reached', {
                  message: 'You have used all 5 free prompts. Sign up to continue.',
                  used: updated.prompt_count,
                  limit: updated.prompt_limit,
                });
              }
            }

            client.emit('ai:done', {
              response: fullText,
              tokensUsed: inputTokens + outputTokens,
              latencyMs: Date.now() - aiStartTime,
            });

            session.isProcessingAI = false;
          },

          onError: (err: Error) => {
            this.logger.error(`Claude error [${client.id}]: ${err.message}`);
            client.emit('error', { code: 'AI_ERROR', message: err.message });
            session.isProcessingAI = false;
          },
        },
      );
    } catch (err) {
      this.logger.error('processPrompt error:', err);
      client.emit('error', { code: 'PROCESSING_FAILED', message: (err as Error).message });
      session.isProcessingAI = false;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  private cleanupSession(socketId: string): void {
    const session = this.sessions.get(socketId);
    if (session) {
      session.closeDeepgram();
      session.deepgramEmitter.removeAllListeners();
      this.sessions.delete(socketId);
      this.logger.log(`Session cleaned up: ${socketId}`);
    }
  }
}
