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
import { VoiceVerificationService, SpeakerIdentificationResult } from './services/voice-verification.service';
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
  /**
   * Maps each Deepgram speaker number → resolved display name.
   * Populated as each new speaker accumulates enough audio for identification.
   */
  identifiedDeepgramSpeakers: Map<number, string>;
  /**
   * Tracks which Deepgram speaker numbers have already had identification dispatched.
   * Prevents re-triggering for the same speaker within a session.
   */
  speakerIdentificationTriggered: Set<number>;
  /**
   * The Deepgram speaker number that produced the most words in the most recent
   * final transcript result. Used to tag incoming audio chunks to the right
   * per-speaker buffer so identification gets clean, separated audio.
   */
  currentDominantSpeaker: number;
  /**
   * Per-speaker audio chunk accumulators keyed by Deepgram speaker number.
   * Chunks are tagged to the speaker dominant at the time of arrival, giving
   * identifyDualSpeaker() speaker-separated audio instead of a mixed stream.
   */
  speakerAudioBuffers: Map<number, Buffer[]>;
  /** Per-speaker buffered byte counts (mirrors speakerAudioBuffers lengths). */
  speakerAudioBytes: Map<number, number>;
  /**
   * Set once identifyDualSpeaker() has biometrically confirmed which Deepgram
   * speaker is the owner. Prevents autoVoiceCalibration from racing with
   * identifyDualSpeaker and double-flipping the ownerSpeakerId.
   */
  ownerBiometricallyConfirmed: boolean;

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

  // ── Single-speaker voice profile building ────────────────────────────────
  /**
   * Accumulated speech seconds from single-speaker (non-dual) sessions.
   * Clean owner-only audio is the highest-quality training signal — no other
   * speaker's voice contaminates it. Once the threshold is reached, the audio
   * is uploaded and used to enroll or reinforce the owner's voice profile.
   */
  singleSpeakerSpeechSeconds: number;
  /** True once the single-speaker profile build has been dispatched this session. */
  singleSpeakerProfileTriggered: boolean;
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
  /** Minimum combined word-speech seconds before triggering biometric calibration. */
  private readonly CALIBRATION_SPEECH_THRESHOLD_S = 3;
  /** Minimum speech seconds in single-speaker mode before building the owner's voice profile. */
  private readonly SINGLE_SPEAKER_PROFILE_THRESHOLD_S = 10;
  /** Per-speaker speech seconds before triggering real-time 1:N identification. */
  private readonly SPEAKER_IDENTIFICATION_THRESHOLD_S = 3;
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

    // Respect the severity level — don't log every recoverable warning as ERROR.
    if (severity === 'warn') {
      this.logger.warn(`[${code}] ${internalMessage}`);
    } else if (severity === 'info') {
      this.logger.log(`[${code}] ${internalMessage}`);
    } else {
      this.logger.error(`[${code}] ${internalMessage}`);
    }

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
        {
          diarize: isDualSpeaker,
          // Dual-speaker/capture-call sessions need a larger utterance window
          // so conversational back-and-forth accumulates into full sentences
          // rather than fragmenting on every brief pause.
          utteranceEndMs: isDualSpeaker ? 2000 : 1500,
          // Switch to nova-2-meeting for diarized sessions — it is trained on
          // multi-speaker meeting recordings and handles echo/background noise
          // much better than the general-purpose nova-2 model.
          meetingMode: isDualSpeaker,
        },
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
        // Single-speaker: 3 s to avoid triggering on mid-thought pauses.
        // Dual-speaker/capture-call: 8 s so a full conversational exchange can
        // accumulate before Claude generates an insight.
        utteranceDebounceMs: isDualSpeaker ? 8_000 : 3_000,
        utteranceDebounceTimer: null,
        cachedAiMemory,
        cachedVoiceSpeakerId,
        otherSpeakerName: null,
        cachedOwnerName,
        pendingOwnerText: '',
        identifiedDeepgramSpeakers: new Map(),
        speakerIdentificationTriggered: new Set(),
        currentDominantSpeaker: 0,
        speakerAudioBuffers: new Map(),
        speakerAudioBytes: new Map(),
        ownerBiometricallyConfirmed: false,
        idleTimeoutHandle: null,
        audioBuffer: [],
        audioBufferBytes: 0,
        speakerWordSeconds: new Map(),
        voiceCalibrationTriggered: false,
        singleSpeakerSpeechSeconds: 0,
        singleSpeakerProfileTriggered: false,
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

          // Update the dominant speaker so incoming audio chunks get tagged to the
          // right per-speaker buffer (drives identifyDualSpeaker audio accuracy).
          const dominantInResult = [...speakerTexts.entries()]
            .sort((a, b) => b[1].length - a[1].length)[0]?.[0];
          if (dominantInResult !== undefined) {
            session.currentDominantSpeaker = dominantInResult;
          }

          // Track per-speaker accumulated speech duration (from word timestamps).
          // This feeds both the auto-calibration threshold and the per-speaker
          // identification trigger below.
          for (const w of words) {
            const spk = w.speaker ?? 0;
            const dur = (w.end ?? 0) - (w.start ?? 0);
            session.speakerWordSeconds.set(
              spk,
              (session.speakerWordSeconds.get(spk) ?? 0) + dur,
            );
          }

          // ── Per-speaker real-time identification ─────────────────────────
          // After word-count calibration has given an initial owner guess, run
          // 1:N identification for EVERY Deepgram speaker (owner included) once
          // they have crossed the speech threshold. identifyDualSpeaker() will
          // confirm the owner biometrically and correct any word-count mistake.
          if (!session.calibrationPhase && !session.isGuest && this.voiceVerificationService.isEnabled) {
            for (const [spkId, seconds] of session.speakerWordSeconds.entries()) {
              if (
                seconds >= this.SPEAKER_IDENTIFICATION_THRESHOLD_S &&
                !session.speakerIdentificationTriggered.has(spkId)
              ) {
                session.speakerIdentificationTriggered.add(spkId);
                this.identifyDualSpeaker(client, session, spkId).catch((err) =>
                  this.logger.error(`[${client.id}] identifyDualSpeaker error (speaker ${spkId}):`, err),
                );
              }
            }
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

          // Grow the shared accumulator so the live-transcript area on the
          // frontend shows the full rolling conversation rather than only the
          // latest Deepgram utterance fragment. The accumulator is cleared when
          // the utteranceEnd debounce fires and processDualSpeakerPrompt runs.
          session.accumulatedTranscript =
            (session.accumulatedTranscript + ' ' + result.transcript).trim();

          client.emit('transcript:update', {
            // Send the ACCUMULATED text, not just the latest utterance.
            transcript: session.accumulatedTranscript,
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

        // ── Owner voice profile building from single-speaker sessions ─────
        // Single-speaker audio is 100% guaranteed to be the owner's voice —
        // the highest-quality training signal we have. Accumulate speech
        // duration and build/reinforce the profile once enough is buffered.
        // This runs silently in the background and never blocks the conversation.
        if (
          !session.isGuest &&
          !session.singleSpeakerProfileTriggered &&
          this.voiceVerificationService.isEnabled
        ) {
          const words: TranscriptWord[] = result.words ?? [];
          if (words.length > 0) {
            for (const w of words) {
              session.singleSpeakerSpeechSeconds += (w.end ?? 0) - (w.start ?? 0);
            }
          } else {
            // Fallback estimate when word timestamps are absent (~2.5 words/sec)
            session.singleSpeakerSpeechSeconds +=
              (result.transcript?.split(/\s+/).filter(Boolean).length ?? 0) / 2.5;
          }

          if (
            session.singleSpeakerSpeechSeconds >= this.SINGLE_SPEAKER_PROFILE_THRESHOLD_S &&
            session.audioBuffer.length > 0
          ) {
            session.singleSpeakerProfileTriggered = true;
            this.buildSingleSpeakerVoiceProfile(client, session).catch((err) =>
              this.logger.error(`[${client.id}] Single-speaker voice profile build failed:`, err),
            );
          }
        }
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

          // ── Dual-speaker / capture-call path ────────────────────────────
          if (session.isDualSpeaker) {
            if (session.calibrationPhase) return;

            const otherText = session.pendingOtherText.trim();
            const ownerText = session.pendingOwnerText.trim();

            // Count every meaningful word from either speaker.
            const combinedWords = `${ownerText} ${otherText}`
              .trim()
              .split(/\s+/)
              .filter(Boolean).length;

            // Need at least 8 combined words before spending a Claude call.
            // Short phrases ("okay", "hi") are not worth an insight.
            if (combinedWords < 8) return;

            session.pendingOtherText = '';
            session.pendingOwnerText = '';
            // Also clear the display accumulator so the live transcript resets
            // after each insight cycle, matching single-speaker behaviour.
            session.accumulatedTranscript = '';

            // If Deepgram detected a genuine second speaker, pass the other
            // person's text as the primary payload; otherwise treat the
            // accumulated owner text as the conversation fragment to analyse
            // (common when diarization merges both streams into speaker 0).
            const primaryText = otherText || ownerText;
            const contextText  = otherText ? ownerText : '';
            const speakerDetected = Boolean(otherText);

            await this.processDualSpeakerPrompt(
              client, session, primaryText, contextText, speakerDetected,
            );
            return;
          }

          // ── Single-speaker path ─────────────────────────────────────────
          const transcript = session.accumulatedTranscript.trim();
          if (!transcript) return;

          const wordCount = transcript.split(/\s+/).filter(Boolean).length;

          // If fewer than 6 words have accumulated, keep them in the buffer
          // and wait for the next utteranceEnd. This prevents "okay", "hi" etc.
          // from firing a solo Claude call — they'll merge with the next phrase.
          if (wordCount < 6) return;

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
        if (!this.sessions.has(client.id)) return; // already cleaned up by 'close' handler
        this.logger.warn(`Deepgram error for session ${client.id}: ${err.message}`);
        client.emit('session:degraded', {
          reason: 'deepgram_error',
          message: 'Voice connection interrupted. Tap the mic to reconnect.',
        });
        this.cleanupSession(client.id);
      });

      // Deepgram closed the WS (readyState → 3). Without this handler audio chunks
      // keep arriving and spam "sendAudio skipped — readyState=3" indefinitely.
      // cleanupSession removes listeners first, so only ONE of 'error'/'close' wins.
      emitter.on('close', () => {
        if (!this.sessions.has(client.id)) return; // already cleaned up by 'error' handler
        this.logger.warn(`[${client.id}] Deepgram connection closed unexpectedly — degrading session`);
        client.emit('session:degraded', {
          reason: 'deepgram_closed',
          message: 'Voice connection dropped. Tap the mic to reconnect.',
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
      // Silently discard audio chunks that arrive in the brief window between
      // session:degraded being emitted and the frontend's MediaRecorder fully
      // stopping. Emitting NO_SESSION here causes a confusing error toast.
      return;
    }

    const buffer = Buffer.isBuffer(payload.chunk)
      ? payload.chunk
      : Buffer.from(payload.chunk);

    session.sendAudio(buffer);

    // ── Per-speaker audio tagging ──────────────────────────────────────────────
    // Tag each incoming chunk to the speaker that was dominant in the last final
    // transcript result. This builds speaker-separated audio buffers that give
    // identifyDualSpeaker() much cleaner input than the full mixed stream.
    // The tag is approximate at speaker transitions (a few hundred ms of overlap)
    // but over 3+ seconds of speech the buffers are dominated by the right voice.
    if (session.isDualSpeaker && !session.isGuest && this.voiceVerificationService.isEnabled) {
      const spk = session.currentDominantSpeaker;
      const spkBufs = session.speakerAudioBuffers.get(spk) ?? [];
      const spkBytes = session.speakerAudioBytes.get(spk) ?? 0;
      if (spkBytes < this.AUDIO_BUFFER_CAP) {
        spkBufs.push(buffer);
        session.speakerAudioBuffers.set(spk, spkBufs);
        session.speakerAudioBytes.set(spk, spkBytes + buffer.length);
      }
    }

    // Buffer audio for voice profile work in both single- and dual-speaker sessions.
    // Dual-speaker: feeds biometric calibration AND per-speaker identification.
    //   Buffering continues after calibration fires so that speakers who appear
    //   mid-session still have recent audio available for identifyDualSpeaker().
    //   autoVoiceCalibration() clears the buffer after grabbing it; it refills
    //   automatically on the next chunks.
    // Single-speaker: feeds owner voice profile build/reinforce (clean owner-only audio).
    const shouldBuffer = !session.isGuest && session.audioBufferBytes < this.AUDIO_BUFFER_CAP;
    const dualSpeakerNeedsBuffer = session.isDualSpeaker;
    const singleSpeakerNeedsBuffer =
      !session.isDualSpeaker &&
      !session.singleSpeakerProfileTriggered &&
      this.voiceVerificationService.isEnabled;

    if (shouldBuffer && (dualSpeakerNeedsBuffer || singleSpeakerNeedsBuffer)) {
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
    speakerDetected = true,
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

      // When diarization detected a second speaker use the "other person said"
      // framing; when the audio stream wasn't separated (capture-call mode where
      // both voices appear as speaker 0) fall back to a neutral summary prompt.
      const userMessage = speakerDetected
        ? `Conversation so far:\n${conversationContext}\n\nOther person just said: "${otherPersonText}"\n\nGive the owner a brief insight.`
        : `Conversation so far:\n${conversationContext}\n\nMost recent exchange: "${otherPersonText}"\n\nGive the owner a brief insight based on the ongoing conversation.`;

      // Use cached ai_memory — no additional DB call needed
      const systemPrompt = this.claudeService.buildDualSpeakerPrompt(
        session.fieldName,
        session.cachedAiMemory ?? undefined,
      );

      // Emit transcript so the frontend can render the turn.
      // When a real second speaker was detected, use 'other' as the speaker label
      // so the frontend shows their name. When only owner speech was available
      // (capture-call with merged streams), emit as 'owner'.
      client.emit('transcript:confirmed', {
        transcript: otherPersonText,
        inputType: 'voice',
        speaker: speakerDetected ? 'other' : 'owner',
        owner: ownerText ? { transcript: ownerText, name: ownerName } : undefined,
        otherSpeaker: speakerDetected ? { transcript: otherPersonText, name: speakerName } : undefined,
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
      //    Catches ambient speech directed at a third person in the room, not topic filtering.
      if (inputType === 'voice' && history.length >= 4) {
        const relevant = await this.claudeService.checkTopicRelevance(userMessage, history, session.fieldName);
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

  // ─── Single-speaker owner voice profile ──────────────────────────────────────
  /**
   * Builds or reinforces the owner's voice profile from a single-speaker session.
   *
   * Single-speaker mode is the highest-quality training signal: the audio
   * contains only the owner's voice with no other speaker contaminating it.
   * Every qualifying single-speaker session improves the biometric model used
   * in future dual-speaker calibration.
   *
   * - No profile yet → enroll the owner (first-time setup).
   * - Profile exists  → add new samples to reinforce the existing embedding.
   */
  private async buildSingleSpeakerVoiceProfile(client: Socket, session: ActiveSession): Promise<void> {
    this.logger.log(
      `[${client.id}] Building owner voice profile from single-speaker session (${session.audioBufferBytes} bytes, ${session.singleSpeakerSpeechSeconds.toFixed(1)} s speech)`,
    );

    const audioData = Buffer.concat(session.audioBuffer);
    session.audioBuffer = [];
    session.audioBufferBytes = 0;

    try {
      const uploadResult = await this.uploadService.uploadBuffer(
        audioData,
        UploadFolder.VOICE_SAMPLES,
        `voice-profile-${session.userId}`,
        'video',
      );
      const audioUrl = uploadResult.secure_url;
      const voiceSpeakerId = session.cachedVoiceSpeakerId;

      if (voiceSpeakerId) {
        // Reinforce existing profile — pass the known ID so the service updates
        // the existing embedding rather than creating a duplicate entry.
        await this.voiceVerificationService.registerSpeaker(
          session.cachedOwnerName,
          audioUrl,
          voiceSpeakerId,
        );
        this.logger.log(
          `[${client.id}] Owner voice profile reinforced from single-speaker session (id=${voiceSpeakerId})`,
        );
      } else {
        // No profile yet — this single-speaker audio gives us a clean first enrollment.
        const regResult = await this.voiceVerificationService.registerSpeaker(
          session.cachedOwnerName,
          audioUrl,
        );
        await this.usersService.update(session.userId, {
          voice_speaker_id: regResult.speakerId,
          voice_embedding_id: regResult.embeddingId,
        });
        session.cachedVoiceSpeakerId = regResult.speakerId;
        this.logger.log(
          `[${client.id}] Owner voice profile enrolled from single-speaker session (id=${regResult.speakerId})`,
        );
      }
    } catch (err) {
      // Non-fatal — the conversation continues; profile just wasn't updated this session.
      this.logger.error(`[${client.id}] Single-speaker voice profile build failed:`, err);
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

      // Per-speaker identification is now driven from the transcript handler
      // via identifyDualSpeaker() — no separate call needed here.

      // Use cached voice_speaker_id — avoids a findById round trip
      const voiceSpeakerId = session.cachedVoiceSpeakerId;

      if (voiceSpeakerId && this.voiceVerificationService.isEnabled) {
        // ── PROFILE REINFORCEMENT ─────────────────────────────────────────────
        // Speaker identification and owner correction are now handled entirely by
        // identifyDualSpeaker(), which runs per-speaker with cleaner, separated
        // audio and a full 1:N comparison (owner + contacts).
        //
        // autoVoiceCalibration's only remaining job here is to add this session's
        // mixed audio to the owner's voice profile so the model improves over time.
        // Fire-and-forget — failure is non-fatal.
        this.voiceVerificationService
          .registerSpeaker(session.cachedOwnerName, audioUrl, voiceSpeakerId)
          .then(() => this.logger.log(`[${client.id}] Owner voice profile reinforced`))
          .catch((err) => this.logger.warn(`[${client.id}] Profile reinforcement failed (non-fatal):`, err));
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
   * Identifies a single Deepgram speaker number using a single 1:N identify call
   * against ALL of this user's registered voice profiles — both the owner's profile
   * and their registered contacts.
   *
   * Uses per-speaker audio (chunks tagged to this speaker while they were dominant)
   * rather than the full mixed stream, producing much cleaner embeddings and higher
   * identification accuracy.
   *
   * If the result matches the owner's registered voice profile, the ownerSpeakerId
   * is confirmed (or corrected if word-count calibration was wrong) and history is
   * relabelled. If it matches a contact, they are named. Either way, a
   * `speaker:identified` event is emitted for the frontend.
   */
  private async identifyDualSpeaker(
    client: Socket,
    session: ActiveSession,
    deepgramSpeakerId: number,
  ): Promise<void> {
    if (session.isGuest) return;

    // ── Build candidate list (owner + contacts) ───────────────────────────────
    // Fetch the user's registered contacts that have a biometric profile.
    const allSpeakers = await this.speakersService.getUserSpeakers(session.userId);
    const contactCandidates = allSpeakers.filter((s) => !s.is_owner && s.voice_speaker_id);

    // Include the owner's profile so identification can distinguish owner from
    // contacts in one pass — this is what allows biometric owner correction.
    const candidateIds: string[] = [];
    if (session.cachedVoiceSpeakerId) {
      candidateIds.push(session.cachedVoiceSpeakerId);
    }
    for (const s of contactCandidates) {
      candidateIds.push(s.voice_speaker_id!);
    }

    const fallbackName = 'Guest Speaker';

    if (candidateIds.length === 0) {
      // No registered profiles at all — nothing to compare against
      session.identifiedDeepgramSpeakers.set(deepgramSpeakerId, fallbackName);
      if (!session.otherSpeakerName) session.otherSpeakerName = fallbackName;
      client.emit('speaker:identified', {
        deepgramSpeakerId,
        speakerName: fallbackName,
        method: 'no_registered_speakers',
        speakerNames: { owner: session.cachedOwnerName, other: session.otherSpeakerName ?? fallbackName },
      });
      return;
    }

    // ── Choose audio: per-speaker buffer is primary, mixed buffer is fallback ─
    // Per-speaker buffers contain only chunks tagged to this speaker while they
    // were the dominant voice, giving the embedding model a much cleaner signal.
    const perSpeakerBufs = session.speakerAudioBuffers.get(deepgramSpeakerId);
    const hasPerSpeakerAudio = perSpeakerBufs && perSpeakerBufs.length > 0;
    const audioData = hasPerSpeakerAudio
      ? Buffer.concat(perSpeakerBufs!)
      : Buffer.concat(session.audioBuffer);

    if (audioData.length === 0) {
      this.logger.warn(`[${client.id}] identifyDualSpeaker: no audio for speaker ${deepgramSpeakerId}`);
      return;
    }

    // ── Upload audio for SpeechBrain to process ───────────────────────────────
    let audioUrl: string;
    try {
      const uploadResult = await this.uploadService.uploadBuffer(
        audioData,
        UploadFolder.VOICE_SAMPLES,
        `spk-id-${client.id}-${deepgramSpeakerId}`,
        'video',
      );
      audioUrl = uploadResult.secure_url;
    } catch (err) {
      this.logger.warn(`[${client.id}] identifyDualSpeaker: upload failed for speaker ${deepgramSpeakerId}:`, err);
      return;
    }

    // ── Single 1:N identify call ──────────────────────────────────────────────
    let result: SpeakerIdentificationResult;
    try {
      result = await this.voiceVerificationService.identifySpeaker(audioUrl, candidateIds);
    } catch (err) {
      this.logger.warn(`[${client.id}] identifyDualSpeaker: identify call failed for speaker ${deepgramSpeakerId} (non-fatal):`, err);
      return;
    }

    this.logger.log(
      `[${client.id}] Speaker ${deepgramSpeakerId} identify result: ` +
      `identified=${result.identified}, matchedId=${result.speakerId ?? 'none'}, ` +
      `score=${result.similarityScore.toFixed(3)}, ` +
      `audio=${hasPerSpeakerAudio ? 'per-speaker' : 'mixed'}, ` +
      `candidates=${result.candidatesChecked}`,
    );

    // ── Resolve who this Deepgram speaker is ─────────────────────────────────
    const isOwner = result.identified && result.speakerId === session.cachedVoiceSpeakerId;
    const matchedContact = result.identified && !isOwner
      ? contactCandidates.find((s) => s.voice_speaker_id === result.speakerId)
      : null;

    let resolvedName: string;
    let method: string;

    if (isOwner) {
      resolvedName = session.cachedOwnerName;
      method = 'voice_id_owner';
    } else if (matchedContact) {
      resolvedName = matchedContact.name;
      method = 'voice_id';
    } else {
      resolvedName = fallbackName;
      method = 'no_match';
    }

    session.identifiedDeepgramSpeakers.set(deepgramSpeakerId, resolvedName);

    // ── Owner correction ──────────────────────────────────────────────────────
    // If biometrics say this Deepgram speaker IS the owner but word-count picked
    // a different speaker, correct it now. Only the first biometric confirmation
    // wins (ownerBiometricallyConfirmed flag prevents a second identification
    // call from double-flipping if both speakers finish identification close together).
    if (isOwner && !session.ownerBiometricallyConfirmed) {
      session.ownerBiometricallyConfirmed = true;

      if (session.ownerSpeakerId !== deepgramSpeakerId) {
        const previousOwner = session.ownerSpeakerId;
        session.ownerSpeakerId = deepgramSpeakerId;

        // Relabel in-memory history so Claude context stays correct
        session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => ({
          ...turn,
          speaker: turn.speaker === 'owner' ? 'other' : 'owner',
        }));

        // Relabel DB messages fire-and-forget
        this.conversationService.relabelSpeakers(session.conversationId).catch((err) =>
          this.logger.error(`[${client.id}] relabelSpeakers (biometric correction) failed:`, err),
        );

        this.logger.log(
          `[${client.id}] Biometric identification corrected owner: ` +
          `was speaker ${previousOwner}, now speaker ${deepgramSpeakerId}`,
        );

        client.emit('speakers:corrected', {
          ownerSpeakerId: deepgramSpeakerId,
          reason: 'biometric_identification',
          speakerNames: { owner: session.cachedOwnerName, other: session.otherSpeakerName ?? fallbackName },
          message: 'Voice confirmed — speaker labels have been corrected.',
        });
      }

      client.emit('calibration:complete', {
        ownerSpeakerId: deepgramSpeakerId,
        method: 'voice_id',
        confidence: result.similarityScore,
        speakerNames: { owner: session.cachedOwnerName, other: session.otherSpeakerName ?? fallbackName },
        message: 'Your voice has been biometrically confirmed.',
      });
    }

    // If this speaker turned out to be a contact but word-count had them as owner,
    // the OTHER Deepgram speaker must be the real owner — flip if not yet confirmed.
    if (matchedContact && !session.ownerBiometricallyConfirmed && session.ownerSpeakerId === deepgramSpeakerId) {
      const correctedOwner = deepgramSpeakerId === 0 ? 1 : 0;
      session.ownerSpeakerId = correctedOwner;

      session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => ({
        ...turn,
        speaker: turn.speaker === 'owner' ? 'other' : 'owner',
      }));

      this.conversationService.relabelSpeakers(session.conversationId).catch((err) =>
        this.logger.error(`[${client.id}] relabelSpeakers (contact flip) failed:`, err),
      );

      this.logger.log(
        `[${client.id}] Speaker ${deepgramSpeakerId} identified as contact "${resolvedName}" ` +
        `— owner corrected to speaker ${correctedOwner}`,
      );

      client.emit('speakers:corrected', {
        ownerSpeakerId: correctedOwner,
        reason: 'contact_identification',
        speakerNames: { owner: session.cachedOwnerName, other: resolvedName },
        message: `${resolvedName} identified — speaker labels have been corrected.`,
      });
    }

    // Keep otherSpeakerName updated for dual-speaker prompt code that reads it
    if (!isOwner && (!session.otherSpeakerName || session.otherSpeakerName === fallbackName)) {
      session.otherSpeakerName = resolvedName;
    }

    client.emit('speaker:identified', {
      deepgramSpeakerId,
      speakerName: resolvedName,
      isOwner,
      method,
      ...(result.identified ? { similarityScore: result.similarityScore } : {}),
      audioSource: hasPerSpeakerAudio ? 'per_speaker' : 'mixed',
      speakerNames: {
        owner: session.cachedOwnerName,
        other: session.otherSpeakerName ?? fallbackName,
      },
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  private cleanupSession(socketId: string): void {
    const session = this.sessions.get(socketId);
    if (!session) return;

    // Delete from the map FIRST so any re-entrant calls (e.g. from closeDeepgram
    // firing a synchronous 'close'/'error' event) find no session and return early.
    this.sessions.delete(socketId);

    // Remove all emitter listeners BEFORE closing so the 'close'/'error' events
    // emitted by socket.close() do not re-trigger the gateway handlers.
    session.deepgramEmitter.removeAllListeners();

    // Cancel all pending timers
    if (session.utteranceDebounceTimer) {
      clearTimeout(session.utteranceDebounceTimer);
      session.utteranceDebounceTimer = null;
    }
    if (session.idleTimeoutHandle) {
      clearTimeout(session.idleTimeoutHandle);
      session.idleTimeoutHandle = null;
    }

    // Explicitly free audio buffers to release memory before GC
    session.audioBuffer = [];
    session.audioBufferBytes = 0;
    session.speakerAudioBuffers.clear();
    session.speakerAudioBytes.clear();

    session.closeDeepgram();
    this.logger.log(`Session cleaned up: ${socketId}`);
  }
}
