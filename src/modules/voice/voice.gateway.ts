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
import { UsersService } from '@/modules/users/users.service';
import { FieldsService } from '@/modules/fields/fields.service';

// ─── Per-socket session state ─────────────────────────────────────────────────

interface DualSpeakerTurn {
  speaker: 'owner' | 'other';
  text: string;
}

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
  /** Confidence score for each final transcript segment, used for quality filtering */
  transcriptConfidences: number[];
  isProcessingAI: boolean;

  // ── Dual-speaker mode ────────────────────────────────────────────────────
  isDualSpeaker: boolean;
  /** Deepgram speaker number (0 or 1) assigned to the owner during calibration */
  ownerSpeakerId: number | null;
  /** true while waiting for owner to say calibration phrase */
  calibrationPhase: boolean;
  /** Full labeled conversation history for both speakers */
  dualSpeakerHistory: DualSpeakerTurn[];
  /** Other person's words accumulated since last Claude trigger */
  pendingOtherText: string;
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

  private readonly FILLER_WORDS = new Set([
    'um', 'uh', 'hmm', 'hm', 'ah', 'er', 'erm', 'mhm',
    'okay', 'ok', 'yeah', 'yep', 'yup', 'nope',
    'right', 'sure', 'well', 'so', 'just', 'anyway',
  ]);

  /**
   * Returns true only if the transcript is worth sending to Claude.
   * Checks: minimum length, Deepgram confidence, and filler-word-only content.
   */
  private isTranscriptMeaningful(
    transcript: string,
    avgConfidence: number,
  ): { pass: boolean; reason?: string } {
    const trimmed = transcript.trim();
    const words = trimmed.split(/\s+/).filter(Boolean);

    // Layer 1 — too short to be a real prompt
    if (words.length < 2 || trimmed.replace(/\s/g, '').length < 8) {
      return { pass: false, reason: 'too_short' };
    }

    // Layer 2 — Deepgram wasn't confident enough (likely noise or mumbling)
    if (avgConfidence < 0.65) {
      return { pass: false, reason: 'low_confidence' };
    }

    // Layer 3 — every word is a filler/non-word
    const meaningfulWords = words.filter(
      (w) => !this.FILLER_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')),
    );
    if (meaningfulWords.length === 0) {
      return { pass: false, reason: 'filler_only' };
    }

    return { pass: true };
  }

  constructor(
    private readonly deepgramService: DeepgramService,
    private readonly claudeService: ClaudeService,
    private readonly conversationService: ConversationService,
    private readonly guestSessionService: GuestSessionService,
    private readonly usersService: UsersService,
    private readonly fieldsService: FieldsService,
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

      // ── Resolve field context ─────────────────────────────────────────────
      // If the client didn't send fieldId/fieldName, look up the user's
      // primary field automatically so it's always saved on the conversation.
      let resolvedFieldId = payload.fieldId;
      let resolvedFieldName = payload.fieldName;

      if (!isGuest && (!resolvedFieldId || !resolvedFieldName)) {
        const primaryField = await this.fieldsService.getUserPrimaryField(userId);
        if (primaryField) {
          resolvedFieldId = resolvedFieldId ?? (primaryField.field_id ?? primaryField.custom_field_id ?? primaryField.id);
          resolvedFieldName = resolvedFieldName ?? primaryField.name;
        }
      }

      // ── Create or resume conversation ─────────────────────────────────────
      let conversationId = payload.conversationId;
      if (!conversationId) {
        const conv = await this.conversationService.createConversation(
          userId,
          payload.mode ?? 'single',
          resolvedFieldId,
        );
        conversationId = conv.id;
      }

      // ── Open Deepgram live session ────────────────────────────────────────
      const isDualSpeaker = payload.mode === 'dual_speaker';
      const { emitter, sendAudio, close } = await this.deepgramService.createLiveSession(
        client.id,
        { diarize: isDualSpeaker },
      );

      const session: ActiveSession = {
        userId,
        conversationId,
        fieldName: resolvedFieldName,
        isGuest,
        guestSessionId,
        deepgramEmitter: emitter,
        sendAudio,
        closeDeepgram: close,
        accumulatedTranscript: '',
        transcriptConfidences: [],
        isProcessingAI: false,
        isDualSpeaker,
        ownerSpeakerId: null,
        calibrationPhase: isDualSpeaker,
        dualSpeakerHistory: [],
        pendingOtherText: '',
      };

      // Forward Deepgram transcript events → client
      emitter.on('transcript', (result) => {
        if (!result.isFinal) {
          client.emit('transcript:update', {
            transcript: (session.accumulatedTranscript + ' ' + result.transcript).trim(),
            isFinal: false,
            confidence: result.confidence,
          });
          return;
        }

        if (typeof result.confidence === 'number') {
          session.transcriptConfidences.push(result.confidence);
        }

        // ── Dual-speaker path ─────────────────────────────────────────────
        if (session.isDualSpeaker) {
          // Reconstruct per-speaker text from word-level speaker tags
          const words: Array<{ word: string; speaker?: number }> = result.words ?? [];
          const speakerTexts = new Map<number, string>();
          for (const w of words) {
            const spk = w.speaker ?? 0;
            speakerTexts.set(spk, ((speakerTexts.get(spk) ?? '') + ' ' + w.word).trim());
          }

          // ── Calibration: identify the owner as whoever speaks the most
          // in the first meaningful transcript (≥3 words from one speaker).
          // Falls back to the first-word speaker if no dominant speaker found.
          if (session.calibrationPhase && words.length >= 3) {
            // Count words per speaker to find the dominant voice
            const wordCounts = new Map<number, number>();
            for (const w of words) {
              const spk = w.speaker ?? 0;
              wordCounts.set(spk, (wordCounts.get(spk) ?? 0) + 1);
            }
            const dominantSpeaker = [...wordCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
            session.ownerSpeakerId = dominantSpeaker;
            session.calibrationPhase = false;
            this.logger.log(`[${client.id}] Owner identified as speaker ${dominantSpeaker} (word counts: ${JSON.stringify(Object.fromEntries(wordCounts))})`);
            client.emit('calibration:complete', {
              ownerSpeakerId: dominantSpeaker,
              message: 'Voice identified. If the labels are wrong, tap "Swap speakers".',
            });
          }

          const ownerSpk = session.ownerSpeakerId ?? 0;

          for (const [spkId, text] of speakerTexts.entries()) {
            if (!text) continue;
            const label: 'owner' | 'other' = spkId === ownerSpk ? 'owner' : 'other';
            session.dualSpeakerHistory.push({ speaker: label, text });

            if (label === 'other') {
              session.pendingOtherText = (session.pendingOtherText + ' ' + text).trim();
            }
          }

          client.emit('transcript:update', {
            transcript: result.transcript,
            isFinal: true,
            confidence: result.confidence,
            speakers: Object.fromEntries(
              Array.from(speakerTexts.entries()).map(([id, text]) => [
                id === ownerSpk ? 'owner' : 'other',
                text,
              ]),
            ),
          });
          return;
        }

        // ── Single-speaker path ───────────────────────────────────────────
        session.accumulatedTranscript =
          (session.accumulatedTranscript + ' ' + result.transcript).trim();

        client.emit('transcript:update', {
          transcript: session.accumulatedTranscript,
          isFinal: true,
          confidence: result.confidence,
        });
      });

      // Auto-trigger Claude after 1s of silence (utteranceEnd) — no mic release needed
      emitter.on('utteranceEnd', async () => {
        if (session.isProcessingAI) return;

        // ── Dual-speaker: trigger only when other person spoke ────────────
        if (session.isDualSpeaker) {
          if (session.calibrationPhase) return; // wait until owner is identified
          const otherText = session.pendingOtherText.trim();
          if (!otherText) return;

          session.pendingOtherText = '';
          await this.processDualSpeakerPrompt(client, session, otherText);
          return;
        }

        // ── Single-speaker path ───────────────────────────────────────────
        const transcript = session.accumulatedTranscript.trim();
        if (!transcript) return;

        const confidences = [...session.transcriptConfidences];
        session.accumulatedTranscript = '';
        session.transcriptConfidences = [];

        const avgConfidence =
          confidences.length > 0
            ? confidences.reduce((a, b) => a + b, 0) / confidences.length
            : 1.0;

        const quality = this.isTranscriptMeaningful(transcript, avgConfidence);
        if (!quality.pass) {
          this.logger.log(`UtteranceEnd filtered [${quality.reason}]: "${transcript}" (conf=${avgConfidence.toFixed(2)})`);
          client.emit('ai:skipped', { reason: quality.reason, transcript });
          return;
        }

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

        await this.processPrompt(client, session, transcript, 'voice');
      });

      emitter.on('error', (err: Error) => {
        client.emit('error', { code: 'DEEPGRAM_ERROR', message: err.message });
      });

      this.sessions.set(client.id, session);

      client.emit('session:ready', {
        conversationId,
        isGuest,
        isDualSpeaker,
        message: isDualSpeaker
          ? 'Dual-speaker mode active. Please say a short phrase so we can identify your voice.'
          : 'Session ready. Start speaking or type a message.',
        ...(isDualSpeaker ? { calibrationRequired: true } : {}),
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
   * User releases mic → flush any transcript not yet sent by utteranceEnd.
   * utteranceEnd handles mid-speech responses; audio:stop catches the remainder.
   */
  @SubscribeMessage('audio:stop')
  async handleAudioStop(@ConnectedSocket() client: Socket): Promise<void> {
    const session = this.sessions.get(client.id);
    if (!session) return;

    const transcript = session.accumulatedTranscript.trim();
    const confidences = session.transcriptConfidences;

    // Reset accumulated state regardless of filter outcome
    session.accumulatedTranscript = '';
    session.transcriptConfidences = [];

    if (!transcript) {
      client.emit('ai:skipped', { reason: 'empty_transcript' });
      return;
    }

    if (session.isProcessingAI) {
      client.emit('ai:skipped', { reason: 'already_processing' });
      return;
    }

    // ── Quality filter — skip low-value transcripts before touching Claude ──
    const avgConfidence =
      confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : 1.0;

    const quality = this.isTranscriptMeaningful(transcript, avgConfidence);
    if (!quality.pass) {
      this.logger.log(`Transcript filtered [${quality.reason}]: "${transcript}" (conf=${avgConfidence.toFixed(2)})`);
      client.emit('ai:skipped', { reason: quality.reason, transcript });
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

  // ─── session:swap_speakers ───────────────────────────────────────────────────
  /**
   * Swaps owner ↔ other labels when calibration assigned them incorrectly.
   * Safe to call at any point during a dual-speaker session.
   *
   * The client sends this when the user says "that's wrong, swap speakers".
   * After swapping, all future transcripts and the existing dualSpeakerHistory
   * are relabelled so Claude context stays consistent.
   */
  @SubscribeMessage('session:swap_speakers')
  handleSwapSpeakers(@ConnectedSocket() client: Socket): void {
    const session = this.sessions.get(client.id);
    if (!session || !session.isDualSpeaker) {
      client.emit('error', { code: 'SWAP_INVALID', message: 'Not in dual-speaker mode' });
      return;
    }

    // Flip the ownerSpeakerId (0 → 1 or 1 → 0)
    if (session.ownerSpeakerId === null) {
      client.emit('error', { code: 'SWAP_INVALID', message: 'Calibration not complete yet' });
      return;
    }

    session.ownerSpeakerId = session.ownerSpeakerId === 0 ? 1 : 0;

    // Relabel the existing history so Claude context is consistent
    session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => ({
      ...turn,
      speaker: turn.speaker === 'owner' ? 'other' : 'owner',
    }));

    // Swap the accumulated pendingOtherText (it was from the wrong speaker)
    // We can't undo already-sent prompts but we can reset pending state
    session.pendingOtherText = '';

    this.logger.log(`[${client.id}] Speakers swapped — owner is now speaker ${session.ownerSpeakerId}`);

    client.emit('calibration:complete', {
      ownerSpeakerId: session.ownerSpeakerId,
      swapped: true,
      message: 'Speaker labels swapped. Your voice is now labelled as Owner.',
    });
  }

  // ─── session:end ─────────────────────────────────────────────────────────────
  @SubscribeMessage('session:end')
  async handleSessionEnd(@ConnectedSocket() client: Socket): Promise<void> {
    const session = this.sessions.get(client.id);

    // Save memory for authenticated (non-guest) users in background
    if (session && !session.isGuest) {
      this.saveSessionMemory(session).catch((err) =>
        this.logger.error('Memory save failed:', err),
      );
    }

    this.cleanupSession(client.id);
    client.emit('session:ended');
  }

  // ─── Dual-speaker prompt processing ──────────────────────────────────────────
  private async processDualSpeakerPrompt(
    client: Socket,
    session: ActiveSession,
    otherPersonText: string,
  ): Promise<void> {
    session.isProcessingAI = true;
    const aiStartTime = Date.now();

    try {
      // Build labeled conversation context for Claude
      const conversationContext = session.dualSpeakerHistory
        .map((t) => `[${t.speaker === 'owner' ? 'Owner' : 'Other Person'}]: ${t.text}`)
        .join('\n');

      const userMessage = `Conversation so far:\n${conversationContext}\n\nOther person just said: "${otherPersonText}"\n\nGive the owner a brief insight.`;

      // Load owner's AI memory for richer context
      let aiMemory: string | undefined;
      if (!session.isGuest) {
        const user = await this.usersService.findById(session.userId);
        aiMemory = user?.ai_memory ?? undefined;
      }

      const systemPrompt = this.claudeService.buildDualSpeakerPrompt(session.fieldName, aiMemory);

      client.emit('transcript:confirmed', { transcript: otherPersonText, inputType: 'voice', speaker: 'other' });
      client.emit('ai:start');

      let firstToken = true;

      await this.claudeService.streamResponse(userMessage, [], systemPrompt, {
        onToken: (token) => {
          if (firstToken) {
            client.emit('ai:latency', { latencyMs: Date.now() - aiStartTime });
            firstToken = false;
          }
          client.emit('ai:token', { token });
        },

        onDone: async (fullText, inputTokens, outputTokens) => {
          await this.conversationService.saveMessage({
            conversationId: session.conversationId,
            role: 'user',
            content: otherPersonText,
            transcript: otherPersonText,
            speakerLabel: 'other',
          });
          await this.conversationService.saveMessage({
            conversationId: session.conversationId,
            role: 'assistant',
            content: fullText,
            tokensUsed: inputTokens + outputTokens,
            latencyMs: Date.now() - aiStartTime,
          });

          // Generate AI title after first exchange (fire-and-forget)
          this.claudeService
            .generateConversationTitle(otherPersonText, fullText, session.fieldName)
            .then((title) => this.conversationService.setTitle(session.conversationId, title))
            .catch((err) => this.logger.error('Dual-speaker title generation failed:', err));

          client.emit('ai:done', {
            response: fullText,
            tokensUsed: inputTokens + outputTokens,
            latencyMs: Date.now() - aiStartTime,
          });
          session.isProcessingAI = false;
        },

        onError: (err) => {
          this.logger.error(`Dual-speaker Claude error [${client.id}]: ${err.message}`);
          client.emit('error', { code: 'AI_ERROR', message: err.message });
          session.isProcessingAI = false;
        },
      });
    } catch (err) {
      this.logger.error('processDualSpeakerPrompt error:', err);
      client.emit('error', { code: 'PROCESSING_FAILED', message: (err as Error).message });
      session.isProcessingAI = false;
    }
  }

  // ─── Save session memory after session ends ───────────────────────────────────
  private async saveSessionMemory(session: ActiveSession): Promise<void> {
    try {
      const history = await this.conversationService.getConversationHistory(
        session.conversationId,
        session.userId,
      );
      if (history.length < 2) return; // not enough content to memorise

      const user = await this.usersService.findById(session.userId);
      if (!user) return;

      const updatedMemory = await this.claudeService.summarizeConversationForMemory(
        history,
        user.ai_memory,
        session.fieldName,
      );

      await this.usersService.update(session.userId, {
        ai_memory: updatedMemory,
        ai_memory_updated_at: new Date(),
      });

      this.logger.log(`Memory saved for user ${session.userId}`);
    } catch (err) {
      this.logger.error('saveSessionMemory error:', err);
    }
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

      // 2. Load conversation history + AI memory for Claude context
      const [history, userRecord] = await Promise.all([
        this.conversationService.getConversationHistory(session.conversationId, session.userId),
        session.isGuest ? Promise.resolve(null) : this.usersService.findById(session.userId),
      ]);
      const historyWithoutCurrent = history.slice(0, -1);
      const aiMemory = userRecord?.ai_memory ?? undefined;
      const systemPrompt = this.claudeService.buildSystemPrompt(session.fieldName, aiMemory);

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

            // 5. Generate AI title after the first exchange (fire-and-forget)
            this.claudeService
              .generateConversationTitle(userMessage, fullText, session.fieldName)
              .then((title) => this.conversationService.setTitle(session.conversationId, title))
              .catch((err) => this.logger.error('Title generation failed:', err));

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
