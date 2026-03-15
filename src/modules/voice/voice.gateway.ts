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
import { Server, Socket } from 'socket.io';
import { EventEmitter } from 'events';

import { DeepgramService } from './services/deepgram.service';
import { ClaudeService } from './services/claude.service';
import { ConversationService, ConversationMode, MessageRole } from './services/conversation.service';

// ─── Per-socket session state ─────────────────────────────────────────────────

interface ActiveSession {
  userId: string;
  conversationId: string;
  fieldName?: string;
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
  @SubscribeMessage('session:start')
  async handleSessionStart(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      userId: string;
      conversationId?: string;
      mode?: ConversationMode;
      fieldId?: string;
      fieldName?: string;
    },
  ): Promise<void> {
    try {
      this.cleanupSession(client.id);

      // Create or resume conversation in DB
      let conversationId = payload.conversationId;
      if (!conversationId) {
        const conv = await this.conversationService.createConversation(
          payload.userId,
          payload.mode ?? 'single',
          payload.fieldId,
        );
        conversationId = conv.id;
      }

      // createLiveSession is now async in v5
      const { emitter, sendAudio, close } = await this.deepgramService.createLiveSession(client.id);

      const session: ActiveSession = {
        userId: payload.userId,
        conversationId,
        fieldName: payload.fieldName,
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
        message: 'Session ready. Start speaking.',
      });

      this.logger.log(`Session started — user: ${payload.userId}, conv: ${conversationId}`);
    } catch (err) {
      this.logger.error('session:start failed', err);
      client.emit('error', {
        code: 'SESSION_START_FAILED',
        message: (err as Error).message,
      });
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
  // User releases mic → send accumulated transcript to Claude
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

    session.isProcessingAI = true;
    session.accumulatedTranscript = '';
    const aiStartTime = Date.now();

    try {
      // 1. Persist user message
      await this.conversationService.saveMessage({
        conversationId: session.conversationId,
        role: 'user',
        content: transcript,
        transcript,
      });

      client.emit('transcript:confirmed', { transcript });
      client.emit('ai:start');

      // 2. Load conversation history for Claude context
      const history = await this.conversationService.getConversationHistory(
        session.conversationId,
        session.userId,
      );

      // Remove the last user turn — we pass it as the current message directly
      const historyWithoutCurrent = history.slice(0, -1);

      const systemPrompt = this.claudeService.buildSystemPrompt(session.fieldName);

      let firstToken = true;

      // 3. Stream Claude response
      await this.claudeService.streamResponse(
        transcript,
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
      this.logger.error('audio:stop error:', err);
      client.emit('error', { code: 'PROCESSING_FAILED', message: (err as Error).message });
      session.isProcessingAI = false;
    }
  }

  // ─── session:end ─────────────────────────────────────────────────────────────
  @SubscribeMessage('session:end')
  handleSessionEnd(@ConnectedSocket() client: Socket): void {
    this.cleanupSession(client.id);
    client.emit('session:ended');
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