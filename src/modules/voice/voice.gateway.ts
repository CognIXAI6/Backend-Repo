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

import { DeepgramService, TranscriptWord } from './services/deepgram.service';
import { ClaudeService } from './services/claude.service';
import { ConversationService, ConversationMode } from './services/conversation.service';
import { GuestSessionService } from './services/guest-session.service';
import { VoiceVerificationService } from './services/voice-verification.service';
import { UploadService, UploadFolder } from '@/modules/upload/upload.service';
import { UsersService } from '@/modules/users/users.service';
import { SpeakersService } from '@/modules/speakers/speakers.service';
import { EmailService } from '@/modules/email/email.service';
import { FieldsService } from '@/modules/fields/fields.service';
import { ErrorLogService } from '@/modules/error-log/error-log.service';

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
  /**
   * Latest non-final (interim) transcript from Deepgram for the current utterance.
   * Deepgram only marks segments as `is_final` after a silence gap, so this holds
   * the most recent rolling text in case audio:stop fires before any final result.
   */
  pendingInterimTranscript: string;
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
  /** Debounce timer — Claude fires only after this much silence (ms) */
  utteranceDebounceMs: number;
  /** Active debounce timeout handle — reset on every new utteranceEnd */
  utteranceDebounceTimer: ReturnType<typeof setTimeout> | null;

  // ── Per-session user cache ────────────────────────────────────────────────
  /**
   * Snapshot of the user row taken at session:start.
   * Eliminates repeated findById() calls on every AI prompt within a session.
   * cachedAiMemory is refreshed after saveSessionMemory() writes a new value.
   */
  cachedAiMemory: string | null;
  cachedVoiceSpeakerId: string | null;

  // ── Idle timeout ─────────────────────────────────────────────────────────
  /** Cleared and reset on every audio:chunk. Fires cleanup after 30 min of silence. */
  idleTimeoutHandle: ReturnType<typeof setTimeout> | null;

  // ── Speaker naming ────────────────────────────────────────────────────────
  /**
   * Display name for the non-owner speaker. Set via session:name_speaker or
   * auto-resolved by identifyOtherSpeaker() after biometric calibration.
   * Falls back to "Guest Speaker" if no registered speaker matches.
   */
  otherSpeakerName: string | null;
  /** Cached display name for the owner (from user record). */
  cachedOwnerName: string;
  /** Owner's accumulated words since the last AI trigger (mirrors pendingOtherText). */
  pendingOwnerText: string;
  /** True once identifyOtherSpeaker() has been dispatched — prevents re-runs. */
  otherSpeakerIdentificationTriggered: boolean;

  // ── Backend voice calibration ─────────────────────────────────────────────
  /**
   * Raw audio chunks buffered for the auto-calibration upload.
   * Capped at AUDIO_BUFFER_CAP bytes — cleared once calibration fires.
   */
  audioBuffer: Buffer[];
  audioBufferBytes: number;
  /** Accumulated speech seconds per Deepgram speaker ID (from word timestamps). */
  speakerWordSeconds: Map<number, number>;
  /** True once calibration has been triggered — prevents re-triggering. */
  voiceCalibrationTriggered: boolean;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

@WebSocketGateway({
  namespace: '/voice',
  // origin:'*' with credentials:true is rejected by every browser (CORS spec).
  // origin:true tells the cors middleware to reflect the request's Origin header,
  // which is valid with credentials and works across all deployment environments.
  cors: { origin: true, credentials: true },
  // Default pingTimeout is 20 s — shorter than a cold Claude response (10-40 s).
  // Raise to 60 s so the connection is not dropped while streaming is in progress.
  pingTimeout: 60_000,
  // Keep pingInterval at 25 s (Socket.IO default) for normal connections.
  pingInterval: 25_000,
})
export class VoiceGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(VoiceGateway.name);
  private readonly sessions = new Map<string, ActiveSession>();

  /** Max bytes to buffer for auto voice calibration (~2MB covers 30+ s of Opus). */
  private readonly AUDIO_BUFFER_CAP = 2 * 1024 * 1024;
  /** Minimum total word-speech seconds before triggering auto calibration. */
  private readonly CALIBRATION_SPEECH_THRESHOLD_S = 5;
  /** Milliseconds of inactivity before a session is auto-closed (30 min). */
  private readonly SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

  private readonly FILLER_WORDS = new Set([
    // Pure noise / hesitation sounds — never carry intent
    'um', 'uh', 'hmm', 'hm', 'ah', 'er', 'erm', 'mhm',
  ]);

  /**
   * Short phrases that are intentional voice commands.
   * These bypass the minimum-length check so "yes", "continue", etc. reach Claude.
   * They are NOT filtered by filler_only because they carry clear conversational intent.
   */
  private readonly VOICE_COMMANDS = new Set([
    'yes', 'no', 'sure', 'okay', 'ok', 'right', 'got it',
    'continue', 'expand', 'more', 'go on', 'keep going', 'tell me more',
    'explain', 'elaborate', 'why', 'how', 'what', 'when', 'where', 'who',
    'really', 'interesting', 'what else', 'and then', 'what next', 'so what',
    'stop', 'pause', 'thanks', 'thank you',
  ]);

  /**
   * Returns true only if the transcript is worth sending to Claude.
   * Checks: minimum length (with voice-command bypass), Deepgram confidence, and filler-word-only content.
   */
  // Regex: ends with comma OR ends with a bare conjunction/incomplete word (≤10 words total).
  // Catches "how about," and "In Nigeria. And, I want to also" without over-filtering.
  private readonly INCOMPLETE_FRAGMENT_RE =
    /[,]$|[\s](and|or|but|so|because|when|if|as|while|then|also|to|the|a|an)\.?$/i;

  private isTranscriptMeaningful(
    transcript: string,
    avgConfidence: number,
  ): { pass: boolean; reason?: string } {
    const trimmed = transcript.trim();
    const lower = trimmed.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const words = trimmed.split(/\s+/).filter(Boolean);

    // Layer 0 — dangling fragment (trailing comma or bare conjunction at end of short utterance)
    if (words.length <= 10 && this.INCOMPLETE_FRAGMENT_RE.test(trimmed)) {
      return { pass: false, reason: 'incomplete_fragment' };
    }

    // Layer 1 — too short, but allow known voice commands through unconditionally
    if (words.length < 2 || trimmed.replace(/\s/g, '').length < 6) {
      if (this.VOICE_COMMANDS.has(lower)) {
        return { pass: true }; // Intentional command — skip remaining checks
      }
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
    private readonly voiceVerificationService: VoiceVerificationService,
    private readonly uploadService: UploadService,
    private readonly usersService: UsersService,
    private readonly fieldsService: FieldsService,
    private readonly emailService: EmailService,
    private readonly errorLogService: ErrorLogService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly speakersService: SpeakersService,
  ) {}

  /**
   * Classifies an AI error, notifies admins if it's a billing/critical issue,
   * and always returns a safe client-facing message — never the raw API error.
   */
  /**
   * Central error emitter — logs internally, sends a safe message to the client.
   * Raw technical errors are NEVER forwarded to the frontend.
   */
  private emitError(
    client: Socket,
    code: string,
    internalMessage: string,
    opts: { clientMessage?: string; severity?: 'info' | 'warn' | 'error' | 'critical'; context?: Record<string, unknown> } = {},
  ): void {
    const severity = opts.severity ?? 'error';
    const clientMessage = opts.clientMessage ?? 'Something went wrong. Please try again.';

    this.logger.error(`[${code}] ${internalMessage}`);

    this.errorLogService.log({
      source: 'voice_gateway',
      code,
      message: internalMessage,
      severity,
      context: { socketId: client.id, ...opts.context },
    });

    client.emit('error', { code, message: clientMessage });
  }

  private handleAiError(client: Socket, err: Error, context: string): void {
    const msg = err.message ?? '';
    const isBilling = /balance|credit|billing|payment|quota/i.test(msg);
    const isRateLimit = /rate.?limit|too.?many.?request/i.test(msg);

    if (isBilling) {
      this.emailService
        .sendAdminAlert(
          'Anthropic API balance too low',
          `Context: ${context}\nError: ${msg}\nTime: ${new Date().toISOString()}`,
        )
        .catch((e) => this.logger.error('Failed to send admin alert email:', e));
    }

    const clientMessage = isRateLimit
      ? 'The AI is busy right now. Please try again in a moment.'
      : 'Something went wrong on our end. Please try again.';

    this.emitError(client, 'AI_ERROR', msg, {
      clientMessage,
      severity: isBilling ? 'critical' : 'error',
      context: { aiContext: context },
    });
  }

  afterInit(): void {
    this.logger.log('🎙️  VoiceGateway live at ws://…/voice');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
    const auth = client.handshake.auth as Record<string, unknown>;
    const token = (auth?.accessToken ?? auth?.token) as string | undefined;
    if (token) {
      try {
        this.jwtService.verify<{ sub: string }>(token, {
          secret: this.configService.get<string>('jwt.secret'),
        });
      } catch {
        this.logger.warn(`Client ${client.id} rejected — invalid JWT at handshake`);
        client.emit('error', { code: 'INVALID_TOKEN', message: 'Your session has expired. Please log in again.' });
        client.disconnect(true);
      }
    }
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
          this.emitError(client, 'INVALID_TOKEN', 'JWT verification failed', { clientMessage: 'Your session has expired. Please log in again.', severity: 'warn' });
          return;
        }
      } else if (payload.guestSessionId) {
        // Guest path — use guestSessionId as pseudo userId
        guestSessionId = payload.guestSessionId;
        userId = guestSessionId; // conversations store this UUID as user_id

        // Single DB call instead of the previous canSendPrompt() + getPromptStatus()
        const guestStatus = await this.guestSessionService.getStatus(guestSessionId);

        isGuest = true;

        // Emit current prompt status so the frontend can show the counter
        client.emit('guest:status', {
          used: guestStatus.used,
          limit: guestStatus.limit,
          remaining: guestStatus.remaining,
        });

        if (!guestStatus.canSend) {
          client.emit('guest:limit_reached', {
            message: 'You have used all 5 free prompts. Sign up to continue.',
            used: guestStatus.used,
            limit: guestStatus.limit,
          });
          return;
        }
      } else {
        this.emitError(client, 'AUTH_REQUIRED', 'session:start called with no auth credentials', { clientMessage: 'Authentication required. Please sign in and try again.', severity: 'warn' });
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

      // ── Load user data once — cached for the session lifetime ───────────────
      // Avoids repeated findById() on every AI prompt within this session.
      let cachedAiMemory: string | null = null;
      let cachedVoiceSpeakerId: string | null = null;
      let cachedOwnerName = 'You';

      if (!isGuest) {
        const userRecord = await this.usersService.findById(userId);
        cachedAiMemory = userRecord?.ai_memory ?? null;
        cachedVoiceSpeakerId = userRecord?.voice_speaker_id ?? null;
        cachedOwnerName = userRecord?.name || userRecord?.email?.split('@')[0] || 'You';
      }

      // ── Create or resume conversation ─────────────────────────────────────
      let conversationId = payload.conversationId;
      if (conversationId) {
        // Validate ownership before attaching — prevents session hijacking
        try {
          await this.conversationService.assertOwnership(conversationId, userId);
        } catch {
          // Ownership check failed; silently create a fresh conversation
          this.logger.warn(`session:start: conversationId ${conversationId} not owned by ${userId} — creating new`);
          conversationId = undefined;
        }
      }
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
        pendingInterimTranscript: '',
        transcriptConfidences: [],
        isProcessingAI: false,
        isDualSpeaker,
        ownerSpeakerId: null,
        calibrationPhase: isDualSpeaker,
        dualSpeakerHistory: [],
        pendingOtherText: '',
        // Single-speaker: 1.5 s feels responsive; dual-speaker: 3 s to accumulate context
        utteranceDebounceMs: isDualSpeaker ? 3_000 : 1_500,
        utteranceDebounceTimer: null,
        cachedAiMemory,
        cachedVoiceSpeakerId,
        otherSpeakerName: null,
        cachedOwnerName,
        pendingOwnerText: '',
        otherSpeakerIdentificationTriggered: false,
        idleTimeoutHandle: null,
        audioBuffer: [],
        audioBufferBytes: 0,
        speakerWordSeconds: new Map(),
        voiceCalibrationTriggered: false,
      };

      // Forward Deepgram transcript events → client
      emitter.on('transcript', (result) => {
        if (!result.isFinal) {
          // Keep the latest interim text so audio:stop can use it as a fallback
          // if no final result has arrived yet (race condition).
          if (!session.isDualSpeaker) {
            session.pendingInterimTranscript = result.transcript;
          }
          client.emit('transcript:update', {
            transcript: (session.accumulatedTranscript + ' ' + result.transcript).trim(),
            isFinal: false,
            confidence: result.confidence,
          });
          return;
        }

        // Final result arrived — interim is now superseded
        session.pendingInterimTranscript = '';

        if (typeof result.confidence === 'number') {
          session.transcriptConfidences.push(result.confidence);
        }

        // ── Dual-speaker path ─────────────────────────────────────────────
        if (session.isDualSpeaker) {
          // Reconstruct per-speaker text from word-level speaker tags
          const words: TranscriptWord[] = result.words ?? [];
          const speakerTexts = new Map<number, string>();
          for (const w of words) {
            const spk = w.speaker ?? 0;
            speakerTexts.set(spk, ((speakerTexts.get(spk) ?? '') + ' ' + w.word).trim());
          }

            // Track per-speaker accumulated speech duration (from word timestamps).
          // This feeds the auto-calibration threshold check below.
          for (const w of words) {
            const spk = w.speaker ?? 0;
            const dur = (w.end ?? 0) - (w.start ?? 0);
            session.speakerWordSeconds.set(
              spk,
              (session.speakerWordSeconds.get(spk) ?? 0) + dur,
            );
          }

          // ── Calibration: identify the owner as whoever speaks the most
          // in the first meaningful transcript (≥3 words from one speaker).
          // This is an initial word-count guess; backend voice biometrics will
          // confirm or correct it asynchronously once enough audio is buffered.
          if (session.calibrationPhase && words.length >= 3) {
            const wordCounts = new Map<number, number>();
            for (const w of words) {
              const spk = w.speaker ?? 0;
              wordCounts.set(spk, (wordCounts.get(spk) ?? 0) + 1);
            }
            const sorted = [...wordCounts.entries()].sort((a, b) => b[1] - a[1]);
            const dominantSpeaker = sorted[0][0];
            const totalWords = [...wordCounts.values()].reduce((a, b) => a + b, 0);
            // Confidence: ratio of dominant speaker's words. 1.0 = only one speaker
            // heard, 0.5 = equal split (least reliable).
            const calibrationConfidence = totalWords > 0 ? sorted[0][1] / totalWords : 1;

            session.ownerSpeakerId = dominantSpeaker;
            session.calibrationPhase = false;
            this.logger.log(
              `[${client.id}] Word-count calibration: owner=speaker ${dominantSpeaker}, confidence=${calibrationConfidence.toFixed(2)}`,
            );
            client.emit('calibration:complete', {
              ownerSpeakerId: dominantSpeaker,
              method: 'word_count',
              confidence: calibrationConfidence,
              speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
              message: calibrationConfidence >= 0.7
                ? 'Voice identified. Biometric verification in progress…'
                : 'Initial speaker assignment made, but confidence is low. Biometric verification in progress…',
            });
          }

          // ── Trigger backend biometric calibration once we have enough speech ──
          // Runs asynchronously after the initial word-count guess, and will
          // correct `ownerSpeakerId` if the biometric result differs.
          if (!session.voiceCalibrationTriggered && !session.isGuest) {
            const totalSpeech = [...session.speakerWordSeconds.values()].reduce(
              (a, b) => a + b,
              0,
            );
            if (
              totalSpeech >= this.CALIBRATION_SPEECH_THRESHOLD_S &&
              session.audioBuffer.length > 0
            ) {
              session.voiceCalibrationTriggered = true;
              this.autoVoiceCalibration(client, session).catch((err) =>
                this.logger.error(`[${client.id}] Auto voice calibration error:`, err),
              );
            }
          }

          const ownerSpk = session.ownerSpeakerId ?? 0;

          for (const [spkId, text] of speakerTexts.entries()) {
            if (!text) continue;
            const label: 'owner' | 'other' = spkId === ownerSpk ? 'owner' : 'other';
            session.dualSpeakerHistory.push({ speaker: label, text });

            if (label === 'other') {
              session.pendingOtherText = (session.pendingOtherText + ' ' + text).trim();
            } else {
              session.pendingOwnerText = (session.pendingOwnerText + ' ' + text).trim();
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
            // Stable display names — frontend maps these to colors and labels.
            // Always included so the UI never needs a separate lookup call.
            speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
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

      // ── Debounced Claude trigger ───────────────────────────────────────────
      // Each utteranceEnd resets the timer. Claude only fires after
      // `utteranceDebounceMs` of continuous silence — giving the conversation
      // time to accumulate enough context before generating an insight.
      emitter.on('utteranceEnd', () => {
        if (session.isProcessingAI) return;

        // Clear any previously scheduled trigger
        if (session.utteranceDebounceTimer) {
          clearTimeout(session.utteranceDebounceTimer);
          session.utteranceDebounceTimer = null;
        }

        session.utteranceDebounceTimer = setTimeout(async () => {
          session.utteranceDebounceTimer = null;
          if (session.isProcessingAI) return;

          // ── Dual-speaker: trigger only when other person spoke ──────────
          if (session.isDualSpeaker) {
            if (session.calibrationPhase) return;
            const otherText = session.pendingOtherText.trim();
            if (!otherText) return;

            const ownerText = session.pendingOwnerText.trim();
            session.pendingOtherText = '';
            session.pendingOwnerText = '';
            await this.processDualSpeakerPrompt(client, session, otherText, ownerText);
            return;
          }

          // ── Single-speaker path ─────────────────────────────────────────
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
            const gs = await this.guestSessionService.getStatus(session.guestSessionId);
            if (!gs.canSend) {
              client.emit('guest:limit_reached', {
                message: 'You have used all 5 free prompts. Sign up to continue.',
                used: gs.used,
                limit: gs.limit,
              });
              return;
            }
          }

          await this.processPrompt(client, session, transcript, 'voice');
        }, session.utteranceDebounceMs);
      });

      emitter.on('error', (err: Error) => {
        this.logger.warn(`Deepgram error for session ${client.id}: ${err.message}`);
        client.emit('session:degraded', {
          reason: 'deepgram_error',
          message: 'Voice connection interrupted. Tap the mic to reconnect.',
        });
        this.cleanupSession(client.id);
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
      this.emitError(client, 'SESSION_START_FAILED', (err as Error).message, { clientMessage: 'Failed to start session. Please refresh and try again.' });
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
      this.emitError(client, 'NO_SESSION', 'audio/text sent before session:start', { clientMessage: 'Session not ready. Please wait a moment and try again.', severity: 'warn' });
      return;
    }

    const buffer = Buffer.isBuffer(payload.chunk)
      ? payload.chunk
      : Buffer.from(payload.chunk);

    session.sendAudio(buffer);

    // Buffer audio for backend voice calibration in dual-speaker sessions.
    // Stop buffering once calibration has triggered (free memory) or cap reached.
    if (
      session.isDualSpeaker &&
      !session.isGuest &&
      !session.voiceCalibrationTriggered &&
      session.audioBufferBytes < this.AUDIO_BUFFER_CAP
    ) {
      session.audioBuffer.push(buffer);
      session.audioBufferBytes += buffer.length;
    }

    // Reset the idle timeout on every audio chunk — session stays alive while
    // the microphone is active. If no audio arrives for 30 minutes, clean up.
    if (session.idleTimeoutHandle) {
      clearTimeout(session.idleTimeoutHandle);
    }
    session.idleTimeoutHandle = setTimeout(() => {
      this.logger.warn(`[${client.id}] Session idle for 30 min — auto-closing`);
      this.cleanupSession(client.id);
      client.emit('session:ended', { reason: 'idle_timeout' });
    }, this.SESSION_IDLE_TIMEOUT_MS);
  }

  // ─── audio:stop ─────────────────────────────────────────────────────────────
  /**
   * User releases mic → flush any transcript not yet sent by utteranceEnd.
   * utteranceEnd handles mid-speech responses; audio:stop catches the remainder.
   *
   * Race-condition fix: Deepgram only marks segments as is_final after a silence
   * gap (~utterance_end_ms). If the user stops the mic quickly, accumulatedTranscript
   * may be empty even though interim text exists. We fall back to pendingInterimTranscript
   * so the user always gets a response on short recordings.
   */
  @SubscribeMessage('audio:stop')
  async handleAudioStop(@ConnectedSocket() client: Socket): Promise<void> {
    const session = this.sessions.get(client.id);
    if (!session) return;

    // Prefer finalized text; fall back to the latest rolling interim if nothing finalized yet
    const transcript = (
      session.accumulatedTranscript.trim() || session.pendingInterimTranscript.trim()
    );
    const confidences = session.transcriptConfidences;

    // Reset accumulated state regardless of filter outcome
    session.accumulatedTranscript = '';
    session.pendingInterimTranscript = '';
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
      const gs = await this.guestSessionService.getStatus(session.guestSessionId);
      if (!gs.canSend) {
        client.emit('guest:limit_reached', {
          message: 'You have used all 5 free prompts. Sign up to continue.',
          used: gs.used,
          limit: gs.limit,
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
      this.emitError(client, 'NO_SESSION', 'audio/text sent before session:start', { clientMessage: 'Session not ready. Please wait a moment and try again.', severity: 'warn' });
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
      const gs = await this.guestSessionService.getStatus(session.guestSessionId);
      if (!gs.canSend) {
        client.emit('guest:limit_reached', {
          message: 'You have used all 5 free prompts. Sign up to continue.',
          used: gs.used,
          limit: gs.limit,
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
      this.emitError(client, 'SWAP_INVALID', 'swap_speakers called outside dual-speaker mode', { clientMessage: 'Speaker swap is only available in dual-speaker mode.', severity: 'warn' });
      return;
    }

    // Flip the ownerSpeakerId (0 → 1 or 1 → 0)
    if (session.ownerSpeakerId === null) {
      this.emitError(client, 'SWAP_INVALID', 'swap_speakers called before calibration complete', { clientMessage: 'Please say a phrase first so we can identify your voice, then swap.', severity: 'warn' });
      return;
    }

    session.ownerSpeakerId = session.ownerSpeakerId === 0 ? 1 : 0;

    // Relabel the existing in-memory history so Claude context is consistent
    session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => ({
      ...turn,
      speaker: turn.speaker === 'owner' ? 'other' : 'owner',
    }));

    // Relabel already-saved conversation_messages in the DB (fire-and-forget)
    this.conversationService.relabelSpeakers(session.conversationId).catch((err) =>
      this.logger.error(`[${client.id}] relabelSpeakers (swap) failed:`, err),
    );

    // Reset pending state — it was from the wrong speaker
    session.pendingOtherText = '';

    this.logger.log(`[${client.id}] Speakers swapped — owner is now speaker ${session.ownerSpeakerId}`);

    client.emit('calibration:complete', {
      ownerSpeakerId: session.ownerSpeakerId,
      swapped: true,
      confidence: 1.0,
      speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
      message: 'Speaker labels swapped. Your voice is now labelled as Owner.',
    });
  }

  // ─── session:name_speaker ────────────────────────────────────────────────────
  /**
   * Sets a display name for one of the speakers.
   *
   * The owner is always "You" internally, but the other speaker defaults to "Other".
   * The frontend can send this at any point (e.g. after the user types the other
   * person's name in a UI field) to give the conversation a human-readable identity.
   *
   * The name is included in every subsequent transcript:update and calibration event
   * so the frontend never needs to maintain its own name lookup.
   */
  @SubscribeMessage('session:name_speaker')
  handleNameSpeaker(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { speaker: 'owner' | 'other'; name: string },
  ): void {
    const session = this.sessions.get(client.id);
    if (!session || !session.isDualSpeaker) {
      this.emitError(client, 'NAME_INVALID', 'session:name_speaker called outside dual-speaker mode', {
        clientMessage: 'Speaker naming is only available in dual-speaker mode.',
        severity: 'warn',
      });
      return;
    }

    const name = (payload.name ?? '').trim().slice(0, 50);
    if (!name) {
      this.emitError(client, 'NAME_INVALID', 'session:name_speaker received empty name', {
        clientMessage: 'Speaker name cannot be empty.',
        severity: 'warn',
      });
      return;
    }

    if (payload.speaker === 'other') {
      session.otherSpeakerName = name;
    }
    // 'owner' name is always "You" — silently ignore attempts to rename it

    this.logger.log(`[${client.id}] Speaker named: ${payload.speaker}="${name}"`);

    client.emit('speaker:named', {
      speaker: payload.speaker,
      name: payload.speaker === 'other' ? session.otherSpeakerName : 'You',
      speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
    });
  }

  // ─── session:verify_owner ────────────────────────────────────────────────────
  /**
   * Manual override for voice calibration.
   *
   * The backend drives calibration automatically via `autoVoiceCalibration()`,
   * which buffers the live audio and verifies/enrolls without any client action.
   *
   * This event exists as an optional escape hatch — the frontend can send it
   * if the user explicitly wants to re-verify using a specific audio clip they
   * recorded and uploaded themselves.
   *
   * Falls back silently to word-count calibration if:
   *   - The user has no registered voice profile
   *   - The voice verification service is unavailable
   */
  @SubscribeMessage('session:verify_owner')
  async handleVerifyOwner(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { audioUrl: string; deepgramSpeakerId: number },
  ): Promise<void> {
    const session = this.sessions.get(client.id);
    if (!session || !session.isDualSpeaker) {
      this.emitError(client, 'VERIFY_INVALID', 'session:verify_owner called outside dual-speaker mode', {
        clientMessage: 'Voice verification is only available in dual-speaker mode.',
        severity: 'warn',
      });
      return;
    }

    if (session.isGuest) {
      client.emit('voice_id:result', {
        verified: false,
        method: 'word_count',
        message: 'Voice ID not available in guest mode. Using automatic speaker detection.',
      });
      return;
    }

    const { audioUrl, deepgramSpeakerId } = payload;

    if (!audioUrl) {
      this.emitError(client, 'VERIFY_INVALID', 'session:verify_owner missing audioUrl', {
        clientMessage: 'Audio URL is required for voice verification.',
        severity: 'warn',
      });
      return;
    }

    if (!this.voiceVerificationService.isEnabled) {
      client.emit('voice_id:result', {
        verified: false,
        method: 'word_count',
        message: 'Voice ID service not configured. Using automatic speaker detection.',
      });
      return;
    }

    try {
      const user = await this.usersService.findById(session.userId);

      if (!user?.voice_speaker_id) {
        client.emit('voice_id:result', {
          verified: false,
          method: 'word_count',
          message: 'No voice profile found. Register your voice first at Settings → Voice ID.',
        });
        return;
      }

      const result = await this.voiceVerificationService.verifySpeaker(
        user.voice_speaker_id,
        audioUrl,
      );

      // Map from voice match → Deepgram speaker ID
      const confirmedOwnerSpeakerId = result.verified
        ? deepgramSpeakerId         // the clip IS the owner
        : deepgramSpeakerId === 0 ? 1 : 0; // the clip is NOT the owner → flip

      // Update session state
      session.ownerSpeakerId = confirmedOwnerSpeakerId;
      session.calibrationPhase = false;

      // Relabel any history that was accumulated before this verification
      session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => {
        const deepgramId = turn.speaker === 'owner'
          ? (confirmedOwnerSpeakerId === 0 ? 0 : 1)
          : (confirmedOwnerSpeakerId === 0 ? 1 : 0);
        return {
          ...turn,
          speaker: deepgramId === confirmedOwnerSpeakerId ? 'owner' : 'other',
        };
      });

      this.logger.log(
        `[${client.id}] Voice ID calibration — verified=${result.verified}, similarity=${result.similarityScore.toFixed(3)}, ownerSpeakerId=${confirmedOwnerSpeakerId}`,
      );

      client.emit('voice_id:result', {
        verified: result.verified,
        similarityScore: result.similarityScore,
        threshold: result.threshold,
        ownerSpeakerId: confirmedOwnerSpeakerId,
        method: 'voice_id',
        message: result.verified
          ? 'Voice confirmed. Your voice is identified.'
          : `Voice did not match (score ${result.similarityScore.toFixed(2)}). Speakers have been reassigned.`,
      });

      client.emit('calibration:complete', {
        ownerSpeakerId: confirmedOwnerSpeakerId,
        method: 'voice_id',
        message: 'Voice identification complete.',
      });
    } catch (err) {
      this.logger.error('Voice ID verification error:', err);
      // Non-fatal — fall back gracefully, don't break the session
      client.emit('voice_id:result', {
        verified: false,
        method: 'word_count',
        message: 'Voice verification failed. Using automatic speaker detection.',
      });
    }
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
    ownerText: string = '',
  ): Promise<void> {
    session.isProcessingAI = true;
    const aiStartTime = Date.now();
    let aiStarted = false;

    const speakerName = session.otherSpeakerName ?? 'Guest Speaker';
    const ownerName = session.cachedOwnerName;

    try {
      // Cap context at the last 40 turns so Claude input doesn't grow unbounded
      const recentHistory = session.dualSpeakerHistory.slice(-40);
      const conversationContext = recentHistory
        .map((t) => `[${t.speaker === 'owner' ? ownerName : speakerName}]: ${t.text}`)
        .join('\n');

      const userMessage = `Conversation so far:\n${conversationContext}\n\nOther person just said: "${otherPersonText}"\n\nGive the owner a brief insight.`;

      // Use cached ai_memory — no additional DB call needed
      const systemPrompt = this.claudeService.buildDualSpeakerPrompt(
        session.fieldName,
        session.cachedAiMemory ?? undefined,
      );

      // Emit both speaker transcripts so the frontend can render all three turns together.
      // Legacy fields (transcript, speaker string) are kept for backward compatibility
      // until the frontend is updated to read the new `owner`/`speaker` objects.
      client.emit('transcript:confirmed', {
        transcript: otherPersonText,   // legacy — was the only transcript
        inputType: 'voice',
        speaker: 'other',              // legacy — was a plain string
        owner: { transcript: ownerText, name: ownerName },
        otherSpeaker: { transcript: otherPersonText, name: speakerName },
      });
      client.emit('ai:start');
      aiStarted = true;

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
          // Save owner turn if they spoke this round
          if (ownerText) {
            await this.conversationService.saveMessage({
              conversationId: session.conversationId,
              role: 'user',
              content: ownerText,
              transcript: ownerText,
              speakerLabel: 'owner',
            });
          }
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
            // Structured turn data so the frontend can render all three segments
            dualSpeaker: {
              owner: { transcript: ownerText, name: ownerName },
              speaker: { transcript: otherPersonText, name: speakerName },
            },
          });
          session.isProcessingAI = false;
        },

        onError: (err) => {
          this.handleAiError(client, err, `dual-speaker [${client.id}]`);
          if (aiStarted) {
            client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
          }
          session.isProcessingAI = false;
        },
      },
      { enableWebSearch: false },
      );
    } catch (err) {
      this.logger.error('processDualSpeakerPrompt error:', err);
      this.emitError(client, 'PROCESSING_FAILED', (err as Error).message, { clientMessage: 'Something went wrong. Please try again.' });
      if (aiStarted) {
        client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
      }
      session.isProcessingAI = false;
    }
  }

  // ─── Save session memory after session ends ───────────────────────────────────
  private async saveSessionMemory(session: ActiveSession): Promise<void> {
    try {
      const history = await this.conversationService.getRecentHistoryForAI(
        session.conversationId,
        80, // use more context for memory summarisation than for live prompts
      );
      if (history.length < 2) return; // not enough content to memorise

      const updatedMemory = await this.claudeService.summarizeConversationForMemory(
        history,
        session.cachedAiMemory, // use cached value — avoids another findById
        session.fieldName,
      );

      await this.usersService.update(session.userId, {
        ai_memory: updatedMemory,
        ai_memory_updated_at: new Date(),
      });

      // Keep the in-session cache up to date in case the session continues
      session.cachedAiMemory = updatedMemory;

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
    // Track whether ai:start was emitted so every exit path can emit ai:done.
    // The frontend relies on ai:done to stop the spinner and unlock the input.
    let aiStarted = false;

    try {
      // 1. Load conversation history FIRST — needed for both topic check and Claude context.
      //    No ownership re-check needed; established at session:start.
      const history = await this.conversationService.getRecentHistoryForAI(
        session.conversationId,
        40,
      );

      // 2. Topic relevance gate (voice only, after ≥4 messages = 2 full turns).
      //    Off-topic speech (narrating a movie, chatting with someone else, etc.)
      //    is silently skipped before any DB write or Claude call.
      if (inputType === 'voice' && history.length >= 4) {
        const relevant = await this.claudeService.checkTopicRelevance(userMessage, history);
        if (!relevant) {
          this.logger.log(`Topic filter blocked: "${userMessage.slice(0, 80)}…"`);
          client.emit('ai:skipped', { reason: 'off_topic', transcript: userMessage });
          session.isProcessingAI = false;
          return;
        }
      }

      // 3. Persist user message (only after passing relevance check)
      await this.conversationService.saveMessage({
        conversationId: session.conversationId,
        role: 'user',
        content: userMessage,
        transcript: inputType === 'voice' ? userMessage : undefined,
      });

      client.emit('transcript:confirmed', { transcript: userMessage, inputType });
      client.emit('ai:start');
      aiStarted = true;

      // 4. Build system prompt using cached ai_memory (set at session:start).
      //    `history` was loaded before the user message was saved, so it already
      //    excludes the current turn — no slice needed.
      const systemPrompt = this.claudeService.buildSystemPrompt(
        session.fieldName,
        session.cachedAiMemory ?? undefined,
      );

      let firstToken = true;

      // 5. Stream Claude response.
      //    Voice disables web search — tool use adds 500ms+ and is incompatible
      //    with near-instant voice UX. Text keeps it for current-events queries.
      await this.claudeService.streamResponse(
        userMessage,
        history,
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
            // 6. Persist assistant message
            await this.conversationService.saveMessage({
              conversationId: session.conversationId,
              role: 'assistant',
              content: fullText,
              tokensUsed: inputTokens + outputTokens,
              latencyMs: Date.now() - aiStartTime,
            });

            // 7. Generate AI title after the first exchange (fire-and-forget)
            this.claudeService
              .generateConversationTitle(userMessage, fullText, session.fieldName)
              .then((title) => this.conversationService.setTitle(session.conversationId, title))
              .catch((err) => this.logger.error('Title generation failed:', err));

            // 8. Increment guest prompt count and emit updated status
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
            this.handleAiError(client, err, `single-speaker [${client.id}]`);
            // Always emit ai:done so the frontend spinner stops and input unlocks.
            if (aiStarted) {
              client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
            }
            session.isProcessingAI = false;
          },
        },
        { enableWebSearch: inputType === 'text' },
      );
    } catch (err) {
      this.logger.error('processPrompt error:', err);
      this.emitError(client, 'PROCESSING_FAILED', (err as Error).message, { clientMessage: 'Something went wrong. Please try again.' });
      if (aiStarted) {
        client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
      }
      session.isProcessingAI = false;
    }
  }

  // ─── Backend auto voice calibration ──────────────────────────────────────────
  /**
   * Uploads the buffered session audio to Cloudinary, then either:
   *  - VERIFICATION: Checks whether the owner's registered voice is present.
   *    If the biometric result differs from the initial word-count guess, the
   *    ownerSpeakerId and conversation history are corrected automatically.
   *  - ENROLLMENT: No voice profile exists yet → registers the dominant speaker
   *    as the owner and persists the profile to the users table (one-time).
   *
   * This runs entirely on the backend — the frontend never needs to upload audio.
   * Falls back silently to the word-count result if the service is unavailable.
   */
  private async autoVoiceCalibration(client: Socket, session: ActiveSession): Promise<void> {
    this.logger.log(`[${client.id}] Auto voice calibration triggered (${session.audioBufferBytes} bytes buffered)`);

    // Grab and free the buffer immediately so GC can reclaim memory
    const audioData = Buffer.concat(session.audioBuffer);
    session.audioBuffer = [];
    session.audioBufferBytes = 0;

    // Dominant speaker by accumulated word-time (same speaker word-count picked as owner)
    const dominantSpeaker =
      [...session.speakerWordSeconds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;

    try {
      // Upload to Cloudinary
      const uploadResult = await this.uploadService.uploadBuffer(
        audioData,
        UploadFolder.VOICE_SAMPLES,
        `voice-cal-${client.id}`,
        'video',
      );
      const audioUrl = uploadResult.secure_url;

      // Identify the other speaker against registered speakers (fire-and-forget)
      if (!session.otherSpeakerIdentificationTriggered) {
        session.otherSpeakerIdentificationTriggered = true;
        this.identifyOtherSpeaker(client, session, audioUrl).catch((err) =>
          this.logger.error(`[${client.id}] Other speaker identification failed:`, err),
        );
      }

      // Use cached voice_speaker_id — avoids a findById round trip
      const voiceSpeakerId = session.cachedVoiceSpeakerId;

      if (voiceSpeakerId && this.voiceVerificationService.isEnabled) {
        // ── VERIFICATION MODE ─────────────────────────────────────────────────
        // Check if the owner's registered voice is present in the session audio.
        const result = await this.voiceVerificationService.verifySpeaker(
          voiceSpeakerId,
          audioUrl,
        );

        this.logger.log(
          `[${client.id}] Voice verification: verified=${result.verified}, score=${result.similarityScore.toFixed(3)}, threshold=${result.threshold}`,
        );

        // verified=true  → dominant speaker IS the owner (word-count was right)
        // verified=false → dominant speaker is NOT the owner → flip
        const confirmedOwner = result.verified
          ? dominantSpeaker
          : dominantSpeaker === 0 ? 1 : 0;

        if (confirmedOwner !== session.ownerSpeakerId) {
          // Biometrics overrule the word-count guess — relabel in-memory history
          session.ownerSpeakerId = confirmedOwner;
          session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => ({
            ...turn,
            speaker: turn.speaker === 'owner' ? 'other' : 'owner',
          }));

          // Relabel already-saved conversation_messages in the DB so they stay
          // consistent with the corrected in-memory state (fire-and-forget).
          this.conversationService.relabelSpeakers(session.conversationId).catch((err) =>
            this.logger.error(`[${client.id}] relabelSpeakers failed:`, err),
          );

          this.logger.log(
            `[${client.id}] Biometrics corrected owner to speaker ${confirmedOwner}`,
          );

          // Tell the frontend to re-render historical messages with flipped labels.
          client.emit('speakers:corrected', {
            ownerSpeakerId: confirmedOwner,
            reason: 'biometric_correction',
            speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
            message: 'Speaker labels corrected by biometrics. Previous messages have been relabelled.',
          });
        }

        session.calibrationPhase = false;

        client.emit('voice_id:result', {
          verified: result.verified,
          similarityScore: result.similarityScore,
          threshold: result.threshold,
          ownerSpeakerId: confirmedOwner,
          method: 'voice_id',
          speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
          message: result.verified
            ? 'Voice confirmed by biometrics.'
            : `Biometrics reassigned speakers (score ${result.similarityScore.toFixed(2)}).`,
        });

        client.emit('calibration:complete', {
          ownerSpeakerId: confirmedOwner,
          method: 'voice_id',
          confidence: 1.0,
          speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
          message: 'Speaker identification complete.',
        });
      } else if (!voiceSpeakerId && this.voiceVerificationService.isEnabled) {
        // ── ENROLLMENT MODE ───────────────────────────────────────────────────
        // First session ever — fetch user only here (enrollment is a one-time event).
        const user = await this.usersService.findById(session.userId);
        if (!user) return;

        const userName = user.name || user.email.split('@')[0];

        const regResult = await this.voiceVerificationService.registerSpeaker(
          userName,
          audioUrl,
        );

        // Persist voice profile to the database
        await this.usersService.update(session.userId, {
          voice_speaker_id: regResult.speakerId,
          voice_embedding_id: regResult.embeddingId,
        });

        // Update session cache so subsequent calibration checks use the new ID
        session.cachedVoiceSpeakerId = regResult.speakerId;

        // Dominant speaker = owner (assumption: the app user speaks the most)
        session.ownerSpeakerId = dominantSpeaker;
        session.calibrationPhase = false;

        this.logger.log(
          `[${client.id}] Voice enrolled: speakerId=${regResult.speakerId}, owner=speaker ${dominantSpeaker}`,
        );

        client.emit('voice_id:result', {
          enrolled: true,
          ownerSpeakerId: dominantSpeaker,
          method: 'voice_enrollment',
          speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
          message: 'Voice profile created. You\'ll be recognized automatically in all future sessions.',
        });

        client.emit('calibration:complete', {
          ownerSpeakerId: dominantSpeaker,
          method: 'voice_enrollment',
          confidence: 1.0,
          speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
          message: 'Voice enrolled and speaker identified.',
        });
      }
      // else: voice verification service not enabled → word-count result stands
    } catch (err) {
      // Non-fatal — word-count calibration already ran, session continues normally
      this.logger.error(`[${client.id}] Auto voice calibration failed:`, err);
    }
  }

  /**
   * Attempts to identify the non-owner speaker by checking the session audio
   * against every registered non-owner speaker for this user.
   * Sets session.otherSpeakerName to the matched speaker's name or "Guest Speaker".
   * Emits `speaker:identified` so the frontend can update the display name immediately.
   */
  private async identifyOtherSpeaker(
    client: Socket,
    session: ActiveSession,
    audioUrl: string,
  ): Promise<void> {
    // Skip for guests or if the user already named the speaker manually
    if (session.isGuest || session.otherSpeakerName) return;

    if (!this.voiceVerificationService.isEnabled) {
      session.otherSpeakerName = 'Guest Speaker';
      client.emit('speaker:identified', {
        speakerName: 'Guest Speaker',
        method: 'service_disabled',
        speakerNames: { owner: session.cachedOwnerName, other: 'Guest Speaker' },
      });
      return;
    }

    const allSpeakers = await this.speakersService.getUserSpeakers(session.userId);
    const candidates = allSpeakers.filter((s) => !s.is_owner && s.voice_speaker_id);

    if (candidates.length === 0) {
      session.otherSpeakerName = 'Guest Speaker';
      client.emit('speaker:identified', {
        speakerName: 'Guest Speaker',
        method: 'no_registered_speakers',
        speakerNames: { owner: session.cachedOwnerName, other: 'Guest Speaker' },
      });
      return;
    }

    let bestMatch: { name: string; score: number } | null = null;

    for (const speaker of candidates) {
      try {
        const result = await this.voiceVerificationService.verifySpeaker(
          speaker.voice_speaker_id!,
          audioUrl,
        );
        if (result.verified && (!bestMatch || result.similarityScore > bestMatch.score)) {
          bestMatch = { name: speaker.name, score: result.similarityScore };
        }
      } catch (err) {
        this.logger.warn(`[${client.id}] Speaker check failed for "${speaker.name}":`, err);
      }
    }

    const identifiedName = bestMatch?.name ?? 'Guest Speaker';
    session.otherSpeakerName = identifiedName;

    this.logger.log(
      `[${client.id}] Other speaker identified: "${identifiedName}"${bestMatch ? ` (score=${bestMatch.score.toFixed(3)})` : ' (no match)'}`,
    );

    client.emit('speaker:identified', {
      speakerName: identifiedName,
      method: bestMatch ? 'voice_match' : 'no_match',
      ...(bestMatch ? { similarityScore: bestMatch.score } : {}),
      speakerNames: { owner: session.cachedOwnerName, other: identifiedName },
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  private cleanupSession(socketId: string): void {
    const session = this.sessions.get(socketId);
    if (session) {
      // Cancel all pending timers
      if (session.utteranceDebounceTimer) {
        clearTimeout(session.utteranceDebounceTimer);
        session.utteranceDebounceTimer = null;
      }
      if (session.idleTimeoutHandle) {
        clearTimeout(session.idleTimeoutHandle);
        session.idleTimeoutHandle = null;
      }

      // Explicitly free audio buffer to release memory before GC
      session.audioBuffer = [];
      session.audioBufferBytes = 0;

      session.closeDeepgram();
      session.deepgramEmitter.removeAllListeners();
      this.sessions.delete(socketId);
      this.logger.log(`Session cleaned up: ${socketId}`);
    }
  }
}
