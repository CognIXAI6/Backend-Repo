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
import { randomUUID } from 'crypto';

import { DeepgramLiveAudioFormat, DeepgramService, TranscriptWord } from './services/deepgram.service';
import { ClaudeService, ConversationImage as ClaudeConversationImage } from './services/claude.service';
import { ConversationService, ConversationMode, SaveTranscriptSegmentDto, ConversationParticipant, UpsertParticipantDto, ConversationImage as DbConversationImage } from './services/conversation.service';
import { GuestSessionService } from './services/guest-session.service';
import { VoiceVerificationService, SpeakerIdentificationResult } from './services/voice-verification.service';
import { UploadService, UploadFolder } from '@/modules/upload/upload.service';
import { UsersService } from '@/modules/users/users.service';
import { SpeakersService } from '@/modules/speakers/speakers.service';
import { EmailService } from '@/modules/email/email.service';
import { FieldsService } from '@/modules/fields/fields.service';
import { ErrorLogService } from '@/modules/error-log/error-log.service';
import { DocumentService } from '@/modules/documents/document.service';
import { PushNotificationService } from '@/modules/notifications/push-notification.service';
import { ProviderSessionState, ProviderCloseInfo } from './interfaces/provider-session.types';
import { ProviderDisruptionReason } from './interfaces/voice-events.types';
import { computeBackoffDelayMs, sleep, PROVIDER_RECOVERY_MAX_ATTEMPTS } from './utils/backoff.util';
import { ToolCallStreamFilter } from './utils/tool-call-stream-filter.util';

// ─── Mode types ───────────────────────────────────────────────────────────────

type RealtimeMode = 'single' | 'dual_speaker' | 'multiple_speaker';

interface ClientAudioFormatHint {
  mimeType?: string;
  encoding?: string;
  sampleRate?: number;
  channels?: number;
}

// ─── Per-socket session state ─────────────────────────────────────────────────

interface DualSpeakerTurn {
  speaker: 'owner' | 'other';
  text: string;
}

interface SpeakerRosterEntry {
  speakerId: string;
  displayName: string;
  voiceSpeakerId: string | null;
  role: 'owner' | 'participant';
}

interface MultiSpeakerTurn {
  deepgramSpeakerId: number;
  speakerId: string | null;
  speakerLabel: string;
  text: string;
  confidence: number;
  startMs: number | null;
  endMs: number | null;
  identificationMethod: 'diarization' | 'voice_id' | 'manual' | 'unknown';
}

interface ResolvedSpeaker {
  speakerId: string | null;
  label: string;
  voiceSpeakerId: string | null;
  method: 'diarization' | 'voice_id' | 'manual' | 'unknown';
  confidence?: number;
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
  sendFinalize: () => void;
  closeDeepgram: () => void;
  accumulatedTranscript: string;
  /**
   * Latest non-final (interim) transcript from Deepgram for the current utterance.
   */
  pendingInterimTranscript: string;
  /** Confidence score for each final transcript segment */
  transcriptConfidences: number[];
  isProcessingAI: boolean;

  // ── Session mode ─────────────────────────────────────────────────────────
  mode: RealtimeMode;
  isDualSpeaker: boolean;
  isMultiSpeaker: boolean;

  // ── Dual-speaker mode ────────────────────────────────────────────────────
  /** Deepgram speaker number (0 or 1) assigned to the owner during calibration */
  ownerSpeakerId: number | null;
  /** true while waiting for owner to say calibration phrase */
  calibrationPhase: boolean;
  /** Full labeled conversation history for both speakers */
  dualSpeakerHistory: DualSpeakerTurn[];
  /** Other person's words accumulated since last Claude trigger */
  pendingOtherText: string;
  /** Owner words accumulated since last Claude trigger */
  pendingOwnerText: string;
  /** Debounce timer — Claude fires only after this much silence (ms) */
  utteranceDebounceMs: number;
  /** Active debounce timeout handle */
  utteranceDebounceTimer: ReturnType<typeof setTimeout> | null;

  // ── Multi-speaker mode ───────────────────────────────────────────────────
  /** Speakers the client pre-selected for this session */
  speakerRoster: SpeakerRosterEntry[];
  speakerRosterByVoiceId: Map<string, SpeakerRosterEntry>;
  /** Voice-ID / manual resolutions per Deepgram speaker number */
  resolvedSpeakers: Map<number, ResolvedSpeaker>;
  /** Full labeled history for multi-speaker mode */
  multiSpeakerHistory: MultiSpeakerTurn[];
  /** Turns pending AI trigger */
  pendingMultiSpeakerTurns: MultiSpeakerTurn[];
  /** Session-local anonymous labels (Guest 1, Guest 2 …) per Deepgram speaker id */
  anonymousSpeakerLabels: Map<number, string>;
  nextAnonymousSpeakerNumber: number;
  /** Audio source metadata for logging/AI context */
  audioSource: 'mic_only' | 'mixed_mic_tab';

  // ── Per-session user cache ────────────────────────────────────────────────
  cachedAiMemory: string | null;
  cachedVoiceSpeakerId: string | null;
  cachedOwnerName: string;

  // ── Speaker naming (dual-speaker) ────────────────────────────────────────
  otherSpeakerName: string | null;

  // ── Real-time speaker identification ─────────────────────────────────────
  identifiedDeepgramSpeakers: Map<number, string>;
  speakerIdentificationTriggered: Set<number>;
  /**
   * Tracks speech-seconds at the time of each identification attempt.
   * When voice ID returns no match, the system waits until the speaker
   * accumulates RETRY_IDENTIFICATION_EXTRA_S more seconds, then retries.
   */
  speakerIdentificationAtSeconds: Map<number, number>;
  /** Deepgram speaker IDs whose last identification attempt returned no match. */
  speakerIdentificationFailed: Set<number>;
  currentDominantSpeaker: number;
  speakerAudioBuffers: Map<number, Buffer[]>;
  speakerAudioBytes: Map<number, number>;
  ownerBiometricallyConfirmed: boolean;
  audioHeaderChunk: Buffer | null;

  // ── Backend voice calibration ─────────────────────────────────────────────
  audioBuffer: Buffer[];
  audioBufferBytes: number;
  speakerWordSeconds: Map<number, number>;
  voiceCalibrationTriggered: boolean;

  // ── Single-speaker voice profile building ────────────────────────────────
  singleSpeakerSpeechSeconds: number;
  singleSpeakerProfileTriggered: boolean;

  // ── Idle timeout ─────────────────────────────────────────────────────────
  idleTimeoutHandle: ReturnType<typeof setTimeout> | null;

  // ── Stream-aware audio sequencing ────────────────────────────────────────
  /**
   * Stable UUID for this recording session — used to scope segment corrections.
   * Regenerated on every new provider/Deepgram session (i.e. every session:start).
   */
  recordingSessionId: string;
  /**
   * Stable client-provided session ID that survives across provider reconnects.
   * Set from payload.clientSessionId; absent for older clients.
   */
  clientSessionId: string | null;
  /** Currently active recorder/stream identity (sent by the frontend per recorder instance). */
  activeStreamId: string | null;
  /** streamId of the last audio:stop this session actually finalized/processed — makes a duplicate audio:stop for the same recording a no-op. */
  lastHandledStopStreamId: string | null;
  /**
   * Last acknowledged sequence per stream (keyed by recordingId).
   * A new recordingId resets the scope — sequence 0 is valid and expected.
   */
  streamSequences: Map<string, number>;
  /** Total cross-stream gap count (for metrics only — does not drive recovery). */
  audioGapCount: number;

  // ── Provider connection lifecycle (recovery) ──────────────────────────────
  providerState: ProviderSessionState;
  /** Incremented each time the underlying Deepgram connection is replaced by recovery. Starts at 0. */
  providerEpoch: number;
  /** Non-null only while providerState === 'recovering'. */
  currentRecoveryId: string | null;
  /** 1-based attempt counter for the in-flight recovery sequence. */
  recoveryAttempt: number;
  /** Exact connect options used for the live Deepgram session — captured once at session:start so recovery can recreate it identically. */
  providerConnectOptions: {
    diarize: boolean;
    utteranceEndMs: number;
    meetingMode: boolean;
    audioFormat?: DeepgramLiveAudioFormat;
  };
  /** Bounded audio replay buffer used only while providerState === 'recovering'. Separate from the speaker-ID audioBuffer above. */
  recoveryAudioBuffer: Array<{ chunk: Buffer; enqueuedAt: number }>;
  recoveryAudioBufferBytes: number;
  /** Wall-clock timestamp when overflow-driven dropping started this recovery cycle; null when not currently dropping. */
  recoveryBufferOverflowStartedAt: number | null;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

@WebSocketGateway({
  namespace: '/voice',
  cors: { origin: true, credentials: true },
  pingTimeout: 60_000,
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
  /**
   * Additional speech seconds required after a failed identification attempt
   * before the system retries. Prevents thrashing on low-audio windows.
   */
  private readonly RETRY_IDENTIFICATION_EXTRA_S = 6;
  /** Milliseconds of inactivity before a session is auto-closed (30 min). */
  private readonly SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

  /**
   * Bounds for the audio replay buffer accumulated while providerState ===
   * 'recovering'. Sized for ~10 s of 16 kHz/16-bit mono PCM; for lower-bitrate
   * client formats (e.g. Opus/WebM) the byte cap is looser than 10 s in
   * practice, with the time cap doing the real work.
   */
  private readonly PROVIDER_RECOVERY_BUFFER_MAX_BYTES = 320_000;
  private readonly PROVIDER_RECOVERY_BUFFER_MAX_MS = 10_000;

  /**
   * Bounded wait for Deepgram to flush its final diarized result after
   * audio:stop, via the Finalize control message. Deepgram doesn't
   * guarantee an acknowledgement when nothing is buffered, so this timeout
   * is the fallback, not the common case.
   */
  private readonly AUDIO_FINALIZE_TIMEOUT_MS = 1_500;

  private readonly FILLER_WORDS = new Set([
    'um', 'uh', 'hmm', 'hm', 'ah', 'er', 'erm', 'mhm',
  ]);

  private readonly VOICE_COMMANDS = new Set([
    'yes', 'no', 'sure', 'okay', 'ok', 'right', 'got it',
    'continue', 'expand', 'more', 'go on', 'keep going', 'tell me more',
    'explain', 'elaborate', 'why', 'how', 'what', 'when', 'where', 'who',
    'really', 'interesting', 'what else', 'and then', 'what next', 'so what',
    'stop', 'pause', 'thanks', 'thank you',
  ]);

  private readonly INCOMPLETE_FRAGMENT_RE =
    /[,]$|[\s](and|or|but|so|because|when|if|as|while|then|also|to|the|a|an)\.?$/i;

  private isTranscriptMeaningful(
    transcript: string,
    avgConfidence: number,
  ): { pass: boolean; reason?: string } {
    const trimmed = transcript.trim();
    const lower = trimmed.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const words = trimmed.split(/\s+/).filter(Boolean);

    if (words.length <= 10 && this.INCOMPLETE_FRAGMENT_RE.test(trimmed)) {
      return { pass: false, reason: 'incomplete_fragment' };
    }

    if (words.length < 2 || trimmed.replace(/\s/g, '').length < 6) {
      if (this.VOICE_COMMANDS.has(lower)) return { pass: true };
      return { pass: false, reason: 'too_short' };
    }

    if (avgConfidence < 0.65) {
      return { pass: false, reason: 'low_confidence' };
    }

    const meaningfulWords = words.filter(
      (w) => !this.FILLER_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')),
    );
    if (meaningfulWords.length === 0) {
      return { pass: false, reason: 'filler_only' };
    }

    return { pass: true };
  }

  private normalizeAudioFormatHint(input?: ClientAudioFormatHint): DeepgramLiveAudioFormat | undefined {
    const encoding = String(input?.encoding ?? '').trim().toLowerCase();
    const mimeType = String(input?.mimeType ?? '').trim().toLowerCase();

    if (encoding !== 'linear16' && mimeType !== 'audio/linear16') {
      return undefined;
    }

    const sampleRate = Number(input?.sampleRate);
    const channels = Number(input?.channels);

    return {
      encoding: 'linear16',
      sampleRate: Number.isFinite(sampleRate) ? Math.min(Math.max(Math.round(sampleRate), 8000), 48000) : 16000,
      channels: channels === 2 ? 2 : 1,
    };
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
    private readonly documentService: DocumentService,
    private readonly pushNotificationService: PushNotificationService,
  ) {}

  private emitError(
    client: Socket,
    code: string,
    internalMessage: string,
    opts: { clientMessage?: string; severity?: 'info' | 'warn' | 'error' | 'critical'; context?: Record<string, unknown> } = {},
  ): void {
    const severity = opts.severity ?? 'error';
    const clientMessage = opts.clientMessage ?? 'Something went wrong. Please try again.';

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

  @SubscribeMessage('session:start')
  async handleSessionStart(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      accessToken?: string;
      guestSessionId?: string;
      conversationId?: string;
      mode?: RealtimeMode;
      fieldId?: string;
      fieldName?: string;
      secondSpeakerName?: string;
      /** Pre-selected speakers for this session (multi-speaker mode) */
      speakerRoster?: Array<{
        speakerId: string;
        displayName: string;
        role?: 'owner' | 'participant';
      }>;
      expectedSpeakerCount?: number;
      /** Audio source hint from the client (Gap 9 Phase 1) */
      audioSource?: 'mic_only' | 'mixed_mic_tab';
      /** Native mobile raw PCM format hint. Web/container uploads omit this. */
      audioFormat?: ClientAudioFormatHint;
    },
  ): Promise<void> {
    try {
      this.cleanupSession(client.id);

      // ── Resolve identity ──────────────────────────────────────────────────
      let userId: string;
      let isGuest: boolean;
      let guestSessionId: string | undefined;

      if (payload.accessToken) {
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
        guestSessionId = payload.guestSessionId;
        userId = guestSessionId;

        const guestStatus = await this.guestSessionService.getStatus(guestSessionId);
        isGuest = true;

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
      let resolvedFieldId = payload.fieldId;
      let resolvedFieldName = payload.fieldName;

      if (!isGuest && (!resolvedFieldId || !resolvedFieldName)) {
        const primaryField = await this.fieldsService.getUserPrimaryField(userId);
        if (primaryField) {
          resolvedFieldId = resolvedFieldId ?? (primaryField.field_id ?? primaryField.custom_field_id ?? primaryField.id);
          resolvedFieldName = resolvedFieldName ?? primaryField.name;
        }
      }

      // ── Load user data once ───────────────────────────────────────────────
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
        try {
          await this.conversationService.assertOwnership(conversationId, userId);
        } catch {
          this.logger.warn(`session:start: conversationId ${conversationId} not owned by ${userId} — creating new`);
          conversationId = undefined;
        }
      }

      const mode: RealtimeMode = payload.mode ?? 'single';
      const isDualSpeaker = mode === 'dual_speaker';
      const isMultiSpeaker = mode === 'multiple_speaker';
      const shouldDiarize = isDualSpeaker || isMultiSpeaker;
      const audioFormat = this.normalizeAudioFormatHint(payload.audioFormat);

      if (!conversationId) {
        const dbMode: ConversationMode = mode === 'multiple_speaker' ? 'multiple_speaker' : (mode as ConversationMode);

        // Reuse the most recent empty conversation for this user+mode rather than
        // creating a new one — prevents accumulation of duplicate "Untitled conversation"
        // rows when the user starts and stops recording without sending any messages.
        const emptyConv = !isGuest
          ? await this.conversationService.findRecentEmptyConversation(userId, dbMode)
          : null;

        if (emptyConv) {
          conversationId = emptyConv.id;
          this.logger.log(`session:start: reusing empty conversation ${conversationId} for user ${userId}`);
        } else {
          const conv = await this.conversationService.createConversation(
            userId,
            dbMode,
            resolvedFieldId,
          );
          conversationId = conv.id;
        }
      }

      // ── Resolve speaker roster (multi-speaker) ────────────────────────────
      const speakerRoster = (!isGuest && isMultiSpeaker)
        ? await this.resolveSpeakerRoster(userId, payload.speakerRoster)
        : [];
      const speakerRosterByVoiceId = new Map<string, SpeakerRosterEntry>(
        speakerRoster
          .filter((e) => e.voiceSpeakerId)
          .map((e) => [e.voiceSpeakerId!, e]),
      );

      // ── Open Deepgram live session ────────────────────────────────────────
      const providerConnectOptions = {
        diarize: shouldDiarize,
        utteranceEndMs: shouldDiarize ? 2000 : 1500,
        meetingMode: shouldDiarize,
        audioFormat,
      };
      const { emitter, sendAudio, sendFinalize, close } = await this.deepgramService.createLiveSession(
        client.id,
        providerConnectOptions,
      );

      const session: ActiveSession = {
        userId,
        conversationId,
        fieldName: resolvedFieldName,
        isGuest,
        guestSessionId,
        deepgramEmitter: emitter,
        sendAudio,
        sendFinalize,
        closeDeepgram: close,
        accumulatedTranscript: '',
        pendingInterimTranscript: '',
        transcriptConfidences: [],
        isProcessingAI: false,
        mode,
        isDualSpeaker,
        isMultiSpeaker,
        ownerSpeakerId: null,
        calibrationPhase: isDualSpeaker,
        dualSpeakerHistory: [],
        pendingOtherText: '',
        pendingOwnerText: '',
        utteranceDebounceMs: shouldDiarize ? 8_000 : 3_000,
        utteranceDebounceTimer: null,
        speakerRoster,
        speakerRosterByVoiceId,
        resolvedSpeakers: new Map(),
        multiSpeakerHistory: [],
        pendingMultiSpeakerTurns: [],
        anonymousSpeakerLabels: new Map(),
        nextAnonymousSpeakerNumber: 1,
        audioSource: payload.audioSource ?? 'mic_only',
        cachedAiMemory,
        cachedVoiceSpeakerId,
        cachedOwnerName,
        otherSpeakerName: payload.secondSpeakerName?.trim() || null,
        identifiedDeepgramSpeakers: new Map(),
        speakerIdentificationTriggered: new Set(),
        speakerIdentificationAtSeconds: new Map(),
        speakerIdentificationFailed: new Set(),
        currentDominantSpeaker: 0,
        speakerAudioBuffers: new Map(),
        speakerAudioBytes: new Map(),
        ownerBiometricallyConfirmed: false,
        audioHeaderChunk: null,
        audioBuffer: [],
        audioBufferBytes: 0,
        speakerWordSeconds: new Map(),
        voiceCalibrationTriggered: false,
        singleSpeakerSpeechSeconds: 0,
        singleSpeakerProfileTriggered: false,
        idleTimeoutHandle: null,
        recordingSessionId: randomUUID(),
        clientSessionId: (payload as any).clientSessionId ?? null,
        activeStreamId: null,
        lastHandledStopStreamId: null,
        streamSequences: new Map(),
        audioGapCount: 0,
        providerState: 'active',
        providerEpoch: 0,
        currentRecoveryId: null,
        recoveryAttempt: 0,
        providerConnectOptions,
        recoveryAudioBuffer: [],
        recoveryAudioBufferBytes: 0,
        recoveryBufferOverflowStartedAt: null,
      };

      this.attachDeepgramListeners(client, session, emitter);

      this.sessions.set(client.id, session);

      // ── Restore durable participants from previous sessions ───────────────
      // Load persisted participants for this conversation so the frontend can
      // restore identity state (names, roles) that survived a reconnect/refresh.
      let restoredParticipants: ConversationParticipant[] = [];
      if (!isGuest) {
        restoredParticipants = await this.conversationService
          .getConversationParticipants(conversationId)
          .catch((err) => {
            this.logger.warn(`[${client.id}] Failed to load conversation participants: ${(err as Error).message}`);
            return [];
          });

        // Ensure the owner is always recorded as a participant.
        this.conversationService.upsertConversationParticipant({
          conversationId,
          userId,
          displayName: cachedOwnerName,
          role: 'owner',
          voiceSpeakerId: cachedVoiceSpeakerId ?? undefined,
        }).catch((err) =>
          this.logger.warn(`[${client.id}] Failed to upsert owner participant: ${(err as Error).message}`),
        );

        // Pre-populate resolvedSpeakers from prior voice-ID confirmations so
        // returning participants are recognised without re-running identification.
        for (const p of restoredParticipants) {
          if (p.voice_confirmed && p.voice_speaker_id) {
            // We can't map to a Deepgram speaker ID yet (provider hasn't assigned
            // clusters), but we pre-load the roster so identifyMultiSpeaker()
            // can match quickly.  The actual mapping happens in identifyMultiSpeaker.
            this.logger.debug(
              `[${client.id}] Restored participant "${p.display_name}" ` +
              `(voiceId=${p.voice_speaker_id}) for conv ${conversationId}`,
            );
          }
        }
      }

      // ── Upsert roster participants ────────────────────────────────────────
      if (!isGuest && speakerRoster.length > 0) {
        for (const entry of speakerRoster) {
          this.conversationService.upsertConversationParticipant({
            conversationId,
            userId,
            displayName: entry.displayName,
            role: entry.role,
            speakerId: entry.speakerId,
            voiceSpeakerId: entry.voiceSpeakerId ?? undefined,
          }).catch((err) =>
            this.logger.warn(`[${client.id}] Failed to upsert roster participant: ${(err as Error).message}`),
          );
        }
      }

      const rosterCount = speakerRoster.length;
      this.logger.log(
        `Session started — user: ${userId} (${isGuest ? 'guest' : 'auth'}), ` +
        `conv: ${conversationId}, mode: ${mode}, roster: ${rosterCount}, ` +
        `audioSource: ${session.audioSource}, restored: ${restoredParticipants.length}`,
      );

      client.emit('session:ready', {
        conversationId,
        voiceSessionId: session.recordingSessionId,
        providerSessionEpoch: session.recordingSessionId,
        // Real incrementing counter (0 at initial ready) — correlates with
        // session:recovered.providerEpoch across a provider reconnect.
        // providerSessionEpoch above is left as-is for backward compatibility.
        providerEpoch: session.providerEpoch,
        clientSessionId: session.clientSessionId,
        isGuest,
        mode,
        isDualSpeaker,
        isMultiSpeaker,
        // Participants restored from prior sessions — frontend uses these to
        // reinstate speaker names and skip the "name your speakers" step.
        restoredParticipants: restoredParticipants.map((p) => ({
          conversationParticipantId: p.id,
          displayName: p.display_name,
          role: p.role,
          canonicalSpeakerId: p.speaker_id,
          voiceSpeakerId: p.voice_speaker_id,
          voiceConfirmed: p.voice_confirmed,
        })),
        message: isMultiSpeaker
          ? `Multi-speaker mode active. Capturing ${rosterCount > 0 ? rosterCount + ' expected speakers' : 'meeting audio'}.`
          : isDualSpeaker
            ? 'Dual-speaker mode active. Please say a short phrase so we can identify your voice.'
            : 'Session ready. Start speaking or type a message.',
        ...(isDualSpeaker ? { calibrationRequired: true } : {}),
        ...(isMultiSpeaker && rosterCount > 0 ? {
          rosterSpeakers: speakerRoster.map((e) => ({ speakerId: e.speakerId, displayName: e.displayName, role: e.role })),
        } : {}),
      });
    } catch (err) {
      this.logger.error('session:start failed', err);
      this.emitError(client, 'SESSION_START_FAILED', (err as Error).message, { clientMessage: 'Failed to start session. Please refresh and try again.' });
    }
  }

  // ─── stream:start ───────────────────────────────────────────────────────────
  //
  // The frontend emits this before the first chunk of every new recorder instance.
  // It announces the new recordingId and stream epoch so the backend can reset
  // sequence tracking without mistaking "sequence 0" for a network gap.
  // It also allows updating audioSource when the recorder switches from
  // mic-only to mixed mic+tab.

  @SubscribeMessage('stream:start')
  handleStreamStart(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      recordingId: string;
      streamEpoch?: number;
      audioSource?: 'mic_only' | 'mixed_mic_tab';
      clientSessionId?: string;
    },
  ): void {
    const session = this.sessions.get(client.id);
    if (!session) return;

    const streamId = payload.recordingId;

    // Initialize sequence scope for this stream at -1 (no chunks received yet).
    // When the first chunk arrives its sequence (typically 0) won't be seen as a gap.
    session.streamSequences.set(streamId, -1);
    session.activeStreamId = streamId;

    if (payload.audioSource) {
      session.audioSource = payload.audioSource;
    }
    if (payload.clientSessionId && !session.clientSessionId) {
      session.clientSessionId = payload.clientSessionId;
    }

    // Reset the container-header capture so the new recorder's header is used
    // for any per-speaker audio reconstruction.
    session.audioHeaderChunk = null;

    this.logger.log(
      `[${client.id}] stream:start — streamId=${streamId} epoch=${payload.streamEpoch ?? 'n/a'} ` +
      `audioSource=${payload.audioSource ?? session.audioSource}`,
    );

    client.emit('stream:ready', {
      recordingId: streamId,
      streamEpoch: payload.streamEpoch ?? 0,
      expectedSequence: 0,
      clientSessionId: session.clientSessionId,
    });
  }

  // ─── audio:chunk ────────────────────────────────────────────────────────────

  @SubscribeMessage('audio:chunk')
  handleAudioChunk(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { chunk: ArrayBuffer | Buffer; sequence?: number; recordingId?: string },
  ): void {
    const session = this.sessions.get(client.id);
    if (!session) return;

    const buffer = Buffer.isBuffer(payload.chunk)
      ? payload.chunk
      : Buffer.from(payload.chunk);

    // While the provider connection is being replaced, hold audio in the
    // bounded recovery buffer instead of dropping it on the floor — it gets
    // replayed in order once the new connection is up (see flushRecoveryBuffer).
    if (session.providerState === 'recovering') {
      this.bufferAudioForRecovery(session, buffer);
    } else {
      session.sendAudio(buffer);
    }

    // Capture the container header for per-speaker audio reconstruction
    if (!session.audioHeaderChunk) {
      session.audioHeaderChunk = buffer;
    }

    // ── Stream-aware sequence tracking ───────────────────────────────────
    // Each recorder instance supplies a `recordingId` that resets when it is
    // recreated (e.g. mic→tab-audio handoff).  Sequence numbers are scoped
    // per recordingId so that an expected "sequence 0" from a new recorder
    // is never classified as a network gap in the previous recorder's stream.
    if (payload.sequence != null) {
      const streamId = payload.recordingId ?? '__legacy__';
      const lastSeq = session.streamSequences.get(streamId) ?? null;

      if (lastSeq !== null && payload.sequence !== lastSeq + 1) {
        // Real gap within the same stream — emit a recoverable warning only.
        // Do NOT destroy the Deepgram session; audio may still be flowing.
        session.audioGapCount += 1;
        this.logger.warn(
          `[${client.id}] Audio gap in stream "${streamId}": ` +
          `expected=${lastSeq + 1} actual=${payload.sequence} (gaps=${session.audioGapCount})`,
        );
        client.emit('audio:continuity_warning', {
          streamId,
          expected: lastSeq + 1,
          actual: payload.sequence,
          recoverable: true,
          message: 'Some audio may be missing. Recording continues.',
        });
      }

      session.streamSequences.set(streamId, payload.sequence);
      if (!session.activeStreamId) session.activeStreamId = streamId;

      client.emit('audio:ack', {
        sequence: payload.sequence,
        streamId,
        clientSessionId: session.clientSessionId,
      });
    }

    // ── Per-speaker audio tagging ─────────────────────────────────────────
    const shouldDiarize = session.isDualSpeaker || session.isMultiSpeaker;
    if (shouldDiarize && !session.isGuest && this.voiceVerificationService.isEnabled) {
      const spk = session.currentDominantSpeaker;
      const spkBufs = session.speakerAudioBuffers.get(spk) ?? [];
      const spkBytes = session.speakerAudioBytes.get(spk) ?? 0;
      if (spkBytes < this.AUDIO_BUFFER_CAP) {
        spkBufs.push(buffer);
        session.speakerAudioBuffers.set(spk, spkBufs);
        session.speakerAudioBytes.set(spk, spkBytes + buffer.length);
      }
    }

    // ── General audio buffering ───────────────────────────────────────────
    const shouldBuffer = !session.isGuest && session.audioBufferBytes < this.AUDIO_BUFFER_CAP;
    const needsBuffer =
      shouldDiarize ||
      (!session.isDualSpeaker && !session.isMultiSpeaker && !session.singleSpeakerProfileTriggered && this.voiceVerificationService.isEnabled);

    if (shouldBuffer && needsBuffer) {
      session.audioBuffer.push(buffer);
      session.audioBufferBytes += buffer.length;
    }

    // ── Reset idle timeout ────────────────────────────────────────────────
    if (session.idleTimeoutHandle) clearTimeout(session.idleTimeoutHandle);
    session.idleTimeoutHandle = setTimeout(() => {
      this.logger.warn(`[${client.id}] Session idle for 30 min — auto-closing`);
      this.cleanupSession(client.id);
      client.emit('session:ended', { reason: 'idle_timeout' });
    }, this.SESSION_IDLE_TIMEOUT_MS);
  }

  // ─── audio:stop ─────────────────────────────────────────────────────────────

  /**
   * Bounded "flush and drain" boundary for audio:stop. audio:stop only
   * proves the client stopped sending audio, not that Deepgram has finished
   * processing what was already sent — diarized (dual/multi-speaker)
   * sessions in particular can still be mid-flight on a final result.
   * Sends Finalize and waits for the resulting 'finalized' signal (or a
   * bounded timeout, since Deepgram doesn't guarantee an acknowledgement
   * when nothing was buffered) before the caller reads any transcript
   * buffer. The existing 'transcript' listener keeps running throughout
   * this wait and updates those buffers exactly as it always does.
   */
  private finalizeAndDrain(session: ActiveSession, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.deepgramEmitter.off('finalized', onFinalized);
        resolve();
      };
      const onFinalized = () => cleanup();
      const timer = setTimeout(cleanup, timeoutMs);
      session.deepgramEmitter.on('finalized', onFinalized);
      try {
        session.sendFinalize();
      } catch (err) {
        this.logger.warn(`sendFinalize threw: ${(err as Error).message}`);
        cleanup();
      }
    });
  }

  @SubscribeMessage('audio:stop')
  async handleAudioStop(@ConnectedSocket() client: Socket): Promise<void> {
    const session = this.sessions.get(client.id);
    if (!session) return;

    const streamId = session.activeStreamId;

    // Duplicate/concurrent audio:stop for the same recording — already
    // handled or already being handled. Set synchronously, before the
    // await below, so two audio:stop events arriving back-to-back (both
    // dispatched before either handler yields) can't both pass this check.
    if (streamId !== null && streamId === session.lastHandledStopStreamId) return;
    session.lastHandledStopStreamId = streamId;

    const drainStartedAt = Date.now();
    await this.finalizeAndDrain(session, this.AUDIO_FINALIZE_TIMEOUT_MS);
    const drainMs = Date.now() - drainStartedAt;

    // A newer recording started while this stop was draining — the buffers
    // this stop would read may now belong to that newer stream. Bail
    // without touching anything; this is what stops a late result from
    // recording A leaking into recording B.
    if (session.activeStreamId !== streamId) {
      this.logger.warn(`[${client.id}] audio:stop for stale streamId=${streamId} (now ${session.activeStreamId}) — dropped, drainMs=${drainMs}`);
      return;
    }

    // Multi-speaker: flush pending turns (minWords=1 so stop never silently discards).
    if (session.isMultiSpeaker) {
      this.logger.log(`[${client.id}] audio:stop streamId=${streamId} drainMs=${drainMs} turnsPending=${session.pendingMultiSpeakerTurns.length}`);
      client.emit('audio:finalized', { recordingId: streamId, transcriptDetected: session.pendingMultiSpeakerTurns.length > 0 });
      await this.flushMultiSpeakerTurns(client, session, { reason: 'audio_stop', minWords: 1 });
      return;
    }

    // Single / dual-speaker path
    const transcript = (
      session.accumulatedTranscript.trim() || session.pendingInterimTranscript.trim()
    );
    const confidences = session.transcriptConfidences;

    session.accumulatedTranscript = '';
    session.pendingInterimTranscript = '';
    session.transcriptConfidences = [];

    this.logger.log(`[${client.id}] audio:stop streamId=${streamId} drainMs=${drainMs} transcriptEmpty=${!transcript}`);
    client.emit('audio:finalized', { recordingId: streamId, transcriptDetected: Boolean(transcript) });

    if (!transcript) {
      client.emit('ai:skipped', { reason: 'empty_transcript' });
      return;
    }

    if (session.isProcessingAI) {
      client.emit('ai:skipped', { reason: 'already_processing' });
      return;
    }

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

  @SubscribeMessage('session:swap_speakers')
  handleSwapSpeakers(@ConnectedSocket() client: Socket): void {
    const session = this.sessions.get(client.id);
    if (!session || !session.isDualSpeaker) {
      this.emitError(client, 'SWAP_INVALID', 'swap_speakers called outside dual-speaker mode', { clientMessage: 'Speaker swap is only available in dual-speaker mode.', severity: 'warn' });
      return;
    }

    if (session.ownerSpeakerId === null) {
      this.emitError(client, 'SWAP_INVALID', 'swap_speakers called before calibration complete', { clientMessage: 'Please say a phrase first so we can identify your voice, then swap.', severity: 'warn' });
      return;
    }

    session.ownerSpeakerId = session.ownerSpeakerId === 0 ? 1 : 0;

    session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => ({
      ...turn,
      speaker: turn.speaker === 'owner' ? 'other' : 'owner',
    }));

    this.conversationService.relabelSpeakers(session.conversationId).catch((err) =>
      this.logger.error(`[${client.id}] relabelSpeakers (swap) failed:`, err),
    );

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

    this.logger.log(`[${client.id}] Speaker named: ${payload.speaker}="${name}"`);

    client.emit('speaker:named', {
      speaker: payload.speaker,
      name: payload.speaker === 'other' ? session.otherSpeakerName : 'You',
      speakerNames: { owner: 'You', other: session.otherSpeakerName ?? 'Other' },
    });
  }

  // ─── session:verify_owner ────────────────────────────────────────────────────

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

      const confirmedOwnerSpeakerId = result.verified
        ? deepgramSpeakerId
        : deepgramSpeakerId === 0 ? 1 : 0;

      session.ownerSpeakerId = confirmedOwnerSpeakerId;
      session.calibrationPhase = false;

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
      client.emit('voice_id:result', {
        verified: false,
        method: 'word_count',
        message: 'Voice verification failed. Using automatic speaker detection.',
      });
    }
  }

  // ─── transcript:correct_speaker (Gap 6) ─────────────────────────────────────

  @SubscribeMessage('transcript:correct_speaker')
  async handleCorrectSpeaker(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: {
      deepgramSpeakerId?: number;
      segmentId?: string;
      speakerId: string;
      applyTo?: 'segment' | 'session_speaker' | 'conversation_speaker';
    },
  ): Promise<void> {
    const session = this.sessions.get(client.id);
    if (!session) {
      this.emitError(client, 'NO_SESSION', 'transcript:correct_speaker called with no active session', {
        clientMessage: 'No active session. Please start a session first.',
        severity: 'warn',
      });
      return;
    }

    const speaker = await this.speakersService.getSpeakerById(session.userId, payload.speakerId);
    if (!speaker) {
      this.emitError(client, 'SPEAKER_NOT_FOUND', `Speaker ${payload.speakerId} not found`, {
        clientMessage: 'Speaker not found.',
        severity: 'warn',
      });
      return;
    }

    try {
      await this.conversationService.correctTranscriptSpeaker({
        conversationId: session.conversationId,
        deepgramSpeakerId: payload.deepgramSpeakerId,
        segmentId: payload.segmentId,
        speakerId: speaker.id,
        speakerLabel: speaker.name,
        applyTo: payload.applyTo ?? 'session_speaker',
        recordingSessionId: session.recordingSessionId,
      });
    } catch (err) {
      this.logger.warn(`[${client.id}] correctTranscriptSpeaker DB error: ${(err as Error).message}`);
      this.emitError(client, 'SPEAKER_CORRECTION_FAILED', (err as Error).message, {
        clientMessage: 'Could not save the speaker correction. Please try again.',
        severity: 'warn',
      });
      return;
    }

    // Update in-memory state only after DB confirms
    if (payload.deepgramSpeakerId != null) {
      session.resolvedSpeakers.set(payload.deepgramSpeakerId, {
        speakerId: speaker.id,
        label: speaker.name,
        voiceSpeakerId: speaker.voice_speaker_id,
        method: 'manual',
        confidence: 1,
      });
    }

    this.logger.log(
      `[${client.id}] Speaker corrected: deepgramId=${payload.deepgramSpeakerId}, speaker="${speaker.name}", applyTo=${payload.applyTo ?? 'session_speaker'}`,
    );

    client.emit('transcript:speaker_corrected', {
      deepgramSpeakerId: payload.deepgramSpeakerId,
      segmentId: payload.segmentId,
      speakerId: speaker.id,
      speakerLabel: speaker.name,
      applyTo: payload.applyTo ?? 'session_speaker',
      persisted: true,
    });
  }

  // ─── transcript:rename_guest (Gap 11) ────────────────────────────────────────

  @SubscribeMessage('transcript:rename_guest')
  async handleRenameGuest(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: {
      deepgramSpeakerId: number;
      displayName: string;
      applyTo?: 'session_speaker' | 'conversation_speaker';
    },
  ): Promise<void> {
    const session = this.sessions.get(client.id);
    if (!session?.isMultiSpeaker) {
      this.emitError(client, 'RENAME_INVALID', 'transcript:rename_guest requires an active multi-speaker session', {
        clientMessage: 'Guest renaming is only available in multi-speaker mode.',
        severity: 'warn',
      });
      return;
    }

    const name = (payload.displayName ?? '').trim().slice(0, 50);
    if (!name) {
      this.emitError(client, 'RENAME_INVALID', 'transcript:rename_guest received empty displayName', {
        clientMessage: 'Display name cannot be empty.',
        severity: 'warn',
      });
      return;
    }

    try {
      const applyTo = payload.applyTo ?? 'session_speaker';
      await this.conversationService.renameAnonymousSpeaker({
        conversationId: session.conversationId,
        deepgramSpeakerId: payload.deepgramSpeakerId,
        speakerLabel: name,
        applyTo,
        recordingSessionId: session.recordingSessionId,
      });
    } catch (err) {
      this.logger.warn(`[${client.id}] renameAnonymousSpeaker DB error: ${(err as Error).message}`);
      this.emitError(client, 'GUEST_RENAME_FAILED', (err as Error).message, {
        clientMessage: 'Could not save the guest name. Please try again.',
        severity: 'warn',
      });
      return;
    }

    // Update in-memory state only after DB confirms
    session.resolvedSpeakers.set(payload.deepgramSpeakerId, {
      speakerId: null,
      label: name,
      voiceSpeakerId: null,
      method: 'manual',
      confidence: 1,
    });
    session.anonymousSpeakerLabels.set(payload.deepgramSpeakerId, name);

    this.logger.log(`[${client.id}] Guest renamed: deepgramId=${payload.deepgramSpeakerId} → "${name}"`);

    // Persist the manual rename as a durable conversation participant so the
    // name survives a provider reconnect and appears in the next session:ready.
    if (!session.isGuest) {
      this.conversationService.upsertConversationParticipant({
        conversationId: session.conversationId,
        userId: session.userId,
        displayName: name,
        role: 'participant',
        voiceConfirmed: false,
      }).catch((err) =>
        this.logger.warn(`[${client.id}] Failed to persist renamed participant: ${(err as Error).message}`),
      );
    }

    client.emit('transcript:speaker_corrected', {
      deepgramSpeakerId: payload.deepgramSpeakerId,
      speakerId: null,
      speakerLabel: name,
      applyTo: payload.applyTo ?? 'session_speaker',
      method: 'manual',
      persisted: true,
    });
  }

  // ─── session:end ─────────────────────────────────────────────────────────────

  @SubscribeMessage('session:end')
  async handleSessionEnd(@ConnectedSocket() client: Socket): Promise<void> {
    const session = this.sessions.get(client.id);

    // Flush any pending multi-speaker turns before tearing down so they are
    // not silently discarded when the user stops recording.
    if (session?.isMultiSpeaker && session.pendingMultiSpeakerTurns.length > 0) {
      await this.flushMultiSpeakerTurns(client, session, { reason: 'session_end', minWords: 1 }).catch(
        (err) => this.logger.error('session:end flush failed:', err),
      );
    }

    if (session && !session.isGuest) {
      this.saveSessionMemory(session).catch((err) =>
        this.logger.error('Memory save failed:', err),
      );
    }

    this.cleanupSession(client.id);
    client.emit('session:ended');
  }

  // ─── Multi-speaker prompt processing (Gap 4) ─────────────────────────────────

  private async processMultiSpeakerPrompt(
    client: Socket,
    session: ActiveSession,
    turns: MultiSpeakerTurn[],
  ): Promise<void> {
    session.isProcessingAI = true;
    const aiStartTime = Date.now();
    let aiStarted = false;

    try {
      // Gap 9: exclude the current turns from the history context so they only
      // appear once in the prompt (under "Latest exchange"), not twice.
      const historyWithoutCurrent = session.multiSpeakerHistory.slice(
        0,
        Math.max(0, session.multiSpeakerHistory.length - turns.length),
      );
      const recentHistory = historyWithoutCurrent.slice(-60);
      const conversationContext = recentHistory
        .map((t) => `[${t.speakerLabel}]: ${t.text}`)
        .join('\n');

      const latestExchange = turns
        .map((t) => `[${t.speakerLabel}]: ${t.text}`)
        .join('\n');

      const uncertainty = turns.some((t) => t.identificationMethod === 'diarization')
        ? ' If speaker attribution is uncertain, avoid overclaiming who said what.'
        : '';

      const claudePrompt =
        `Conversation so far:\n${conversationContext}\n\n` +
        `Latest exchange:\n${latestExchange}\n\n` +
        `Give the owner a brief, useful insight.${uncertainty}`;

      const msDocContext = await this.conversationService.getFullDocumentContext(session.conversationId, session.userId).catch(() => null);
      const systemPrompt = this.claudeService.buildDualSpeakerPrompt(
        session.fieldName,
        session.cachedAiMemory ?? undefined,
        msDocContext,
      );

      // Gap 8: persist the user message and segments BEFORE starting the AI stream
      // so they are never lost if the stream errors or the client disconnects.
      const userContent = turns.map((t) => `[${t.speakerLabel}]: ${t.text}`).join('\n');
      const rawTranscript = turns.map((t) => t.text).join(' ');

      const segments = this.buildMultiSpeakerSegmentDtos(session, turns);
      await this.conversationService.saveMessageWithTranscriptSegments(
        {
          conversationId: session.conversationId,
          role: 'user',
          content: userContent,
          transcript: rawTranscript,
          speakerLabel: 'multiple_speakers',
        },
        segments,
      );

      client.emit('transcript:confirmed', {
        mode: 'multiple_speaker',
        inputType: 'voice',
        transcript: rawTranscript,
        segments: turns,
      });
      client.emit('ai:start');
      aiStarted = true;

      let firstToken = true;
      const toolCallFilter = new ToolCallStreamFilter();

      await this.claudeService.streamResponse(claudePrompt, [], systemPrompt, {
        onToken: (token) => {
          if (firstToken) {
            client.emit('ai:latency', { latencyMs: Date.now() - aiStartTime });
            firstToken = false;
          }
          const safeToken = toolCallFilter.push(token);
          if (safeToken) client.emit('ai:token', { token: safeToken });
        },

        onDone: async (fullText, inputTokens, outputTokens) => {
          await this.conversationService.saveMessage({
            conversationId: session.conversationId,
            role: 'assistant',
            content: fullText,
            tokensUsed: inputTokens + outputTokens,
            latencyMs: Date.now() - aiStartTime,
          });

          this.claudeService
            .generateConversationTitle(rawTranscript, fullText, session.fieldName)
            .then(async (title) => {
              const wasSet = await this.conversationService.setTitle(session.conversationId, title);
              if (wasSet) client.emit('conversation:titled', { conversationId: session.conversationId, title });
            })
            .catch((err) => this.logger.error('Multi-speaker title generation failed:', err));

          client.emit('ai:done', {
            response: fullText,
            tokensUsed: inputTokens + outputTokens,
            latencyMs: Date.now() - aiStartTime,
            multiSpeaker: { segments: turns },
          });
          session.isProcessingAI = false;
        },

        onError: (err) => {
          this.handleAiError(client, err, `multiple-speaker [${client.id}]`);
          if (aiStarted) client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
          session.isProcessingAI = false;
        },
      },
      { enableWebSearch: false },
      );
    } catch (err) {
      this.logger.error('processMultiSpeakerPrompt error:', err);
      this.emitError(client, 'PROCESSING_FAILED', (err as Error).message, { clientMessage: 'Something went wrong. Please try again.' });
      if (aiStarted) client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
      session.isProcessingAI = false;
    }
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
      const recentHistory = session.dualSpeakerHistory.slice(-40);
      const conversationContext = recentHistory
        .map((t) => `[${t.speaker === 'owner' ? ownerName : speakerName}]: ${t.text}`)
        .join('\n');

      const userMessage = speakerDetected
        ? `Conversation so far:\n${conversationContext}\n\nOther person just said: "${otherPersonText}"\n\nGive the owner a brief insight.`
        : `Conversation so far:\n${conversationContext}\n\nMost recent exchange: "${otherPersonText}"\n\nGive the owner a brief insight based on the ongoing conversation.`;

      const dsDocContext = await this.conversationService.getFullDocumentContext(session.conversationId, session.userId).catch(() => null);
      const systemPrompt = this.claudeService.buildDualSpeakerPrompt(
        session.fieldName,
        session.cachedAiMemory ?? undefined,
        dsDocContext,
      );

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
      const toolCallFilter = new ToolCallStreamFilter();

      await this.claudeService.streamResponse(userMessage, [], systemPrompt, {
        onToken: (token) => {
          if (firstToken) {
            client.emit('ai:latency', { latencyMs: Date.now() - aiStartTime });
            firstToken = false;
          }
          const safeToken = toolCallFilter.push(token);
          if (safeToken) client.emit('ai:token', { token: safeToken });
        },

        onDone: async (fullText, inputTokens, outputTokens) => {
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

          this.claudeService
            .generateConversationTitle(otherPersonText, fullText, session.fieldName)
            .then(async (title) => {
              const wasSet = await this.conversationService.setTitle(session.conversationId, title);
              if (wasSet) client.emit('conversation:titled', { conversationId: session.conversationId, title });
            })
            .catch((err) => this.logger.error('Dual-speaker title generation failed:', err));

          client.emit('ai:done', {
            response: fullText,
            tokensUsed: inputTokens + outputTokens,
            latencyMs: Date.now() - aiStartTime,
            dualSpeaker: {
              owner: { transcript: ownerText, name: ownerName },
              speaker: { transcript: otherPersonText, name: speakerName },
            },
          });
          session.isProcessingAI = false;
        },

        onError: (err) => {
          this.handleAiError(client, err, `dual-speaker [${client.id}]`);
          if (aiStarted) client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
          session.isProcessingAI = false;
        },
      },
      { enableWebSearch: false },
      );
    } catch (err) {
      this.logger.error('processDualSpeakerPrompt error:', err);
      this.emitError(client, 'PROCESSING_FAILED', (err as Error).message, { clientMessage: 'Something went wrong. Please try again.' });
      if (aiStarted) client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
      session.isProcessingAI = false;
    }
  }

  // ─── Save session memory ──────────────────────────────────────────────────────

  private async saveSessionMemory(session: ActiveSession): Promise<void> {
    try {
      const history = await this.conversationService.getRecentHistoryForAI(
        session.conversationId,
        80,
      );
      if (history.length < 2) return;

      const updatedMemory = await this.claudeService.summarizeConversationForMemory(
        history,
        session.cachedAiMemory,
        session.fieldName,
      );

      await this.usersService.update(session.userId, {
        ai_memory: updatedMemory,
        ai_memory_updated_at: new Date(),
      });

      session.cachedAiMemory = updatedMemory;
      this.logger.log(`Memory saved for user ${session.userId}`);
    } catch (err) {
      this.logger.error('saveSessionMemory error:', err);
    }
  }

  // ─── Core single-speaker prompt processing ───────────────────────────────────

  private async processPrompt(
    client: Socket,
    session: ActiveSession,
    userMessage: string,
    inputType: 'voice' | 'text',
  ): Promise<void> {
    session.isProcessingAI = true;
    const aiStartTime = Date.now();
    let aiStarted = false;

    try {
      const history = await this.conversationService.getRecentHistoryForAI(session.conversationId, 40);

      if (inputType === 'voice' && history.length >= 4) {
        const relevant = await this.claudeService.checkTopicRelevance(userMessage, history, session.fieldName);
        if (!relevant) {
          this.logger.log(`Topic filter blocked: "${userMessage.slice(0, 80)}…"`);
          client.emit('ai:skipped', { reason: 'off_topic', transcript: userMessage });
          session.isProcessingAI = false;
          return;
        }
      }

      await this.conversationService.saveMessage({
        conversationId: session.conversationId,
        role: 'user',
        content: userMessage,
        transcript: inputType === 'voice' ? userMessage : undefined,
      });

      client.emit('transcript:confirmed', { transcript: userMessage, inputType });
      client.emit('ai:start');
      aiStarted = true;

      // Document generation is registered as a real tool for every
      // authenticated turn — NOT gated behind a single-message keyword
      // regex. A real request routinely builds up over several turns
      // ("I want a strategy for X" -> clarifying questions -> "yes, with
      // sample numbers" -> "in document format"), and no one message in
      // that sequence need contain a trigger verb+noun pair. Trying to
      // pre-guess intent with a regex just reproduces that bug under a new
      // phrasing every time; Claude's own tool-use judgment (guided by the
      // system prompt) is what tool-calling exists to handle instead.
      const documentGenerationEnabled = !session.isGuest;

      // Soft hint used ONLY to decide whether this voice turn is worth the
      // latency of also registering web_search (voice search is off by
      // default for response speed) — never a gate on whether
      // generate_document itself is available.
      const documentIntentHint =
        /\b(?:prepar(?:e|es|ing)|creat(?:e|es|ing)|generat(?:e|es|ing)|writ(?:e|es|ing)|mak(?:e|es|ing)|draft(?:s|ing)?|put together)\b.{0,30}\b(document|report|file|proposal|paper|essay|article|doc|write-up)\b/i.test(userMessage);

      // Load document context: conversation attachments + field resources (Resources tab).
      const documentContext = await this.conversationService
        .getFullDocumentContext(session.conversationId, session.userId)
        .catch((err) => {
          this.logger.warn(`Failed to load document context: ${err.message}`);
          return null;
        });

      const systemPrompt = this.claudeService.buildSystemPrompt(
        session.fieldName,
        session.cachedAiMemory ?? undefined,
        documentContext,
        documentGenerationEnabled,
      );

      // Load all images attached to this conversation — passed as image content
      // blocks on every AI call so the AI can still answer questions about an
      // image several messages after it was uploaded.
      const conversationImages = await this.conversationService
        .getConversationImagesForAI(session.conversationId)
        .catch(() => [] as DbConversationImage[]);

      const visionImages: ClaudeConversationImage[] = conversationImages.map((img) => ({
        mimeType: img.mime_type as ClaudeConversationImage['mimeType'],
        imageBase64: img.image_base64,
        filename: img.filename,
      }));

      // Captured inside onDocumentRequest, read inside onDone to link the
      // assistant message permanently to the generated document record.
      let generatedDocId: string | null = null;

      // Stable job ID emitted in document:generating so the client can correlate
      // document:ready / document:failed events back to the originating request.
      const docJobId = documentGenerationEnabled ? randomUUID() : '';

      let firstToken = true;
      const toolCallFilter = new ToolCallStreamFilter();

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
            const safeToken = toolCallFilter.push(token);
            if (safeToken) client.emit('ai:token', { token: safeToken });
          },

          onDone: async (fullText: string, inputTokens: number, outputTokens: number) => {
            // Safety net: if Claude returned nothing (rare but possible with very garbled
            // or ambiguous input), synthesise a clarification response so the user is
            // never left staring at a blank screen. Emit it as a token first so the
            // frontend renders it identically to a streamed response.
            const UNCLEAR_FALLBACK =
              `- I didn't quite catch that — could you rephrase?\n` +
              `- Try asking something specific, like: "Explain [topic] step by step"\n` +
              `- Or: "What are the key trends in ${session.fieldName ?? 'my industry'}?"`;

            const responseText = fullText.trim() ? fullText : UNCLEAR_FALLBACK;

            if (!fullText.trim()) {
              this.logger.warn(`[${client.id}] Empty AI response — sending clarification fallback`);
              client.emit('ai:token', { token: UNCLEAR_FALLBACK });
            }

            await this.conversationService.saveMessage({
              conversationId: session.conversationId,
              role: 'assistant',
              content: responseText,
              tokensUsed: inputTokens + outputTokens,
              latencyMs: Date.now() - aiStartTime,
              // Link this message to the generated document so it persists in history.
              documentId: generatedDocId ?? undefined,
            });

            this.claudeService
              .generateConversationTitle(userMessage, responseText, session.fieldName)
              .then(async (title) => {
                const wasSet = await this.conversationService.setTitle(session.conversationId, title);
                if (wasSet) client.emit('conversation:titled', { conversationId: session.conversationId, title });
              })
              .catch((err) => this.logger.error('Title generation failed:', err));

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
              response: responseText,
              tokensUsed: inputTokens + outputTokens,
              latencyMs: Date.now() - aiStartTime,
            });

            session.isProcessingAI = false;
          },

          onError: (err: Error) => {
            this.handleAiError(client, err, `single-speaker [${client.id}]`);
            if (aiStarted) client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
            session.isProcessingAI = false;
          },

          onDocumentRequest: documentGenerationEnabled
            ? async (req) => {
                this.logger.log(`[${client.id}] Document generation requested: "${req.title}"`);
                // Include jobId so the client can match this event to future ready/failed events.
                client.emit('document:generating', { jobId: docJobId, title: req.title, topic: req.topic });

                try {
                  const result = await this.documentService.generateAndUpload({
                    userId: session.userId,
                    conversationId: session.conversationId,
                    title: req.title,
                    topic: req.topic,
                    sections: req.sections,
                    researchContext: req.researchContext,
                    depth: req.depth,
                    format: req.format,
                  });

                  // Capture docId — onDone picks it up to link the assistant message.
                  generatedDocId = result.docId;

                  client.emit('document:ready', {
                    jobId: docJobId,
                    docId: result.docId,
                    title: req.title,
                    topic: req.topic,
                    format: req.format ?? 'docx',
                    downloadUrl: result.downloadUrl,
                  });

                  this.logger.log(`[${client.id}] Document ready: ${result.downloadUrl}`);

                  // Fire-and-forget push notification — socket already delivered the event,
                  // so push is a best-effort duplicate for users who may have closed the tab.
                  this.pushNotificationService
                    .sendToUser(session.userId, {
                      title: 'Your document is ready',
                      body: req.title,
                      data: { docId: result.docId, downloadUrl: result.downloadUrl, jobId: docJobId },
                    })
                    .catch((err) => this.logger.warn(`Push notification failed for doc ${result.docId}:`, err));
                  return result;
                } catch (err) {
                  this.logger.error(`[${client.id}] Document generation failed for "${req.title}":`, err);
                  client.emit('document:failed', {
                    jobId: docJobId,
                    title: req.title,
                    reason: 'We couldn\'t generate your document. Please try again.',
                    canRetry: true,
                  });
                  throw err;
                }
              }
            : undefined,
        },
        {
          // Enable web search for text requests, and for voice turns that
          // look document-adjacent (so a voice-triggered document still
          // gets research-enriched) — voice search stays off by default
          // for response latency otherwise.
          enableWebSearch: inputType === 'text' || documentIntentHint,
          enableDocumentGeneration: documentGenerationEnabled,
          // Include every image attached to this conversation on every call.
          images: visionImages.length > 0 ? visionImages : undefined,
        },
      );
    } catch (err) {
      this.logger.error('processPrompt error:', err);
      this.emitError(client, 'PROCESSING_FAILED', (err as Error).message, { clientMessage: 'Something went wrong. Please try again.' });
      if (aiStarted) client.emit('ai:done', { response: '', latencyMs: Date.now() - aiStartTime });
      session.isProcessingAI = false;
    }
  }

  // ─── Single-speaker owner voice profile ──────────────────────────────────────

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
        await this.voiceVerificationService.registerSpeaker(
          session.cachedOwnerName,
          audioUrl,
          voiceSpeakerId,
        );
        this.logger.log(`[${client.id}] Owner voice profile reinforced from single-speaker session (id=${voiceSpeakerId})`);
      } else {
        const regResult = await this.voiceVerificationService.registerSpeaker(
          session.cachedOwnerName,
          audioUrl,
        );
        await this.usersService.update(session.userId, {
          voice_speaker_id: regResult.speakerId,
          voice_embedding_id: regResult.embeddingId,
        });
        session.cachedVoiceSpeakerId = regResult.speakerId;
        this.logger.log(`[${client.id}] Owner voice profile enrolled from single-speaker session (id=${regResult.speakerId})`);
      }
    } catch (err) {
      this.logger.error(`[${client.id}] Single-speaker voice profile build failed:`, err);
    }
  }

  // ─── Backend auto voice calibration ──────────────────────────────────────────

  private async autoVoiceCalibration(client: Socket, session: ActiveSession): Promise<void> {
    this.logger.log(`[${client.id}] Auto voice calibration triggered (${session.audioBufferBytes} bytes buffered)`);

    const audioData = Buffer.concat(session.audioBuffer);
    session.audioBuffer = [];
    session.audioBufferBytes = 0;

    const dominantSpeaker =
      [...session.speakerWordSeconds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;

    try {
      const uploadResult = await this.uploadService.uploadBuffer(
        audioData,
        UploadFolder.VOICE_SAMPLES,
        `voice-cal-${client.id}`,
        'video',
      );
      const audioUrl = uploadResult.secure_url;

      const voiceSpeakerId = session.cachedVoiceSpeakerId;

      if (voiceSpeakerId && this.voiceVerificationService.isEnabled) {
        this.voiceVerificationService
          .registerSpeaker(session.cachedOwnerName, audioUrl, voiceSpeakerId)
          .then(() => this.logger.log(`[${client.id}] Owner voice profile reinforced`))
          .catch((err) => this.logger.warn(`[${client.id}] Profile reinforcement failed (non-fatal):`, err));
      } else if (!voiceSpeakerId && this.voiceVerificationService.isEnabled) {
        const user = await this.usersService.findById(session.userId);
        if (!user) return;

        const userName = user.name || user.email.split('@')[0];
        const regResult = await this.voiceVerificationService.registerSpeaker(userName, audioUrl);

        await this.usersService.update(session.userId, {
          voice_speaker_id: regResult.speakerId,
          voice_embedding_id: regResult.embeddingId,
        });

        session.cachedVoiceSpeakerId = regResult.speakerId;
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
    } catch (err) {
      this.logger.error(`[${client.id}] Auto voice calibration failed:`, err);
    }
  }

  // ─── Dual-speaker 1:N identification ─────────────────────────────────────────

  private async identifyDualSpeaker(
    client: Socket,
    session: ActiveSession,
    deepgramSpeakerId: number,
  ): Promise<void> {
    if (session.isGuest) return;

    const allSpeakers = await this.speakersService.getUserSpeakers(session.userId);
    const contactCandidates = allSpeakers.filter((s) => !s.is_owner && s.voice_speaker_id);

    const candidateIds: string[] = [];
    if (session.cachedVoiceSpeakerId) candidateIds.push(session.cachedVoiceSpeakerId);
    for (const s of contactCandidates) candidateIds.push(s.voice_speaker_id!);

    const fallbackName = 'Guest Speaker';

    if (candidateIds.length === 0) {
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

    const perSpeakerBufs = session.speakerAudioBuffers.get(deepgramSpeakerId);
    const hasPerSpeakerAudio = !!(perSpeakerBufs && perSpeakerBufs.length > 0);
    let audioData: Buffer;
    if (hasPerSpeakerAudio) {
      const headerChunks = session.audioHeaderChunk ? [session.audioHeaderChunk] : [];
      audioData = Buffer.concat([...headerChunks, ...perSpeakerBufs!]);
    } else {
      audioData = Buffer.concat(session.audioBuffer);
    }

    if (audioData.length === 0) {
      this.logger.warn(`[${client.id}] identifyDualSpeaker: no audio for speaker ${deepgramSpeakerId}`);
      return;
    }

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

    let result: SpeakerIdentificationResult;
    try {
      result = await this.voiceVerificationService.identifySpeaker(audioUrl, candidateIds);
    } catch (err) {
      this.logger.warn(`[${client.id}] identifyDualSpeaker: identify call failed (non-fatal):`, err);
      return;
    }

    this.logger.log(
      `[${client.id}] Speaker ${deepgramSpeakerId} identify result: ` +
      `identified=${result.identified}, matchedId=${result.speakerId ?? 'none'}, ` +
      `score=${result.similarityScore.toFixed(3)}, ` +
      `audio=${hasPerSpeakerAudio ? 'per-speaker' : 'mixed'}, ` +
      `candidates=${result.candidatesChecked}`,
    );

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
      // Mark as failed so the retry loop can re-attempt when more audio accumulates.
      session.speakerIdentificationFailed.add(deepgramSpeakerId);
    }

    session.identifiedDeepgramSpeakers.set(deepgramSpeakerId, resolvedName);

    if (isOwner && !session.ownerBiometricallyConfirmed) {
      session.ownerBiometricallyConfirmed = true;

      if (session.ownerSpeakerId !== deepgramSpeakerId) {
        const previousOwner = session.ownerSpeakerId;
        session.ownerSpeakerId = deepgramSpeakerId;

        session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => ({
          ...turn,
          speaker: turn.speaker === 'owner' ? 'other' : 'owner',
        }));

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

  // ─── Multi-speaker 1:N identification (Gap 3 / Gap 11) ───────────────────────

  private async identifyMultiSpeaker(
    client: Socket,
    session: ActiveSession,
    deepgramSpeakerId: number,
  ): Promise<void> {
    if (session.isGuest) return;

    // Build candidate voice IDs from session roster first.
    // When no roster was provided, fall back to all account-wide enrolled speakers
    // and build a map from external voiceSpeakerId → local speakers.id so we
    // never store an external ID in the speakers_id FK column (Gap 4).
    const candidateIds: string[] = session.speakerRoster
      .map((e) => e.voiceSpeakerId)
      .filter((id): id is string => Boolean(id));

    // voiceId → local speaker entry for account-wide fallback resolution
    const accountSpeakerByVoiceId = new Map<string, { id: string; name: string }>();

    if (candidateIds.length === 0) {
      this.logger.warn(`[${client.id}] identifyMultiSpeaker: no roster voice IDs — falling back to account-wide matching`);
      const allSpeakers = await this.speakersService.getUserSpeakers(session.userId);
      for (const s of allSpeakers) {
        if (s.voice_speaker_id) {
          candidateIds.push(s.voice_speaker_id);
          accountSpeakerByVoiceId.set(s.voice_speaker_id, { id: s.id, name: s.name });
        }
      }
    }

    const anonymousLabel = this.getAnonymousSpeakerLabel(session, deepgramSpeakerId);

    if (candidateIds.length === 0) {
      const resolved: ResolvedSpeaker = { speakerId: null, label: anonymousLabel, voiceSpeakerId: null, method: 'diarization' };
      session.resolvedSpeakers.set(deepgramSpeakerId, resolved);
      client.emit('speaker:identified', { deepgramSpeakerId, speakerId: null, speakerLabel: anonymousLabel, method: 'diarization' });
      return;
    }

    const perSpeakerBufs = session.speakerAudioBuffers.get(deepgramSpeakerId);
    const hasPerSpeakerAudio = !!(perSpeakerBufs && perSpeakerBufs.length > 0);
    let audioData: Buffer;
    if (hasPerSpeakerAudio) {
      const headerChunks = session.audioHeaderChunk ? [session.audioHeaderChunk] : [];
      audioData = Buffer.concat([...headerChunks, ...perSpeakerBufs!]);
    } else {
      audioData = Buffer.concat(session.audioBuffer);
    }

    if (audioData.length === 0) {
      this.logger.warn(`[${client.id}] identifyMultiSpeaker: no audio for speaker ${deepgramSpeakerId}`);
      return;
    }

    let audioUrl: string;
    try {
      const uploadResult = await this.uploadService.uploadBuffer(
        audioData, UploadFolder.VOICE_SAMPLES, `multi-spk-id-${client.id}-${deepgramSpeakerId}`, 'video',
      );
      audioUrl = uploadResult.secure_url;
    } catch (err) {
      this.logger.warn(`[${client.id}] identifyMultiSpeaker: upload failed for speaker ${deepgramSpeakerId}:`, err);
      return;
    }

    let result: SpeakerIdentificationResult;
    try {
      result = await this.voiceVerificationService.identifySpeaker(audioUrl, candidateIds);
    } catch (err) {
      this.logger.warn(`[${client.id}] identifyMultiSpeaker: identify call failed (non-fatal):`, err);
      return;
    }

    this.logger.log(
      `[${client.id}] Multi-speaker ${deepgramSpeakerId} identify: ` +
      `identified=${result.identified}, matchedId=${result.speakerId ?? 'none'}, ` +
      `score=${result.similarityScore.toFixed(3)}, candidates=${result.candidatesChecked}`,
    );

    // ── Gap 4: always resolve to local speakers.id, never the external voice ID ──
    let resolvedName: string;
    let resolvedSpeakerId: string | null = null;
    let resolvedVoiceSpeakerId: string | null = null;
    let method: 'voice_id' | 'diarization' = 'diarization';

    if (result.identified && result.speakerId) {
      resolvedVoiceSpeakerId = result.speakerId;

      // ── Consolidation: check if this voiceSpeakerId is already resolved under
      // a different Deepgram speaker ID. Deepgram re-numbers speakers in long sessions,
      // so the same person may appear as Speaker 0 early on and Speaker 5 later.
      // When that happens, reuse the existing resolution instead of creating a
      // duplicate "Guest N" entry for the same person.
      const priorEntry = [...session.resolvedSpeakers.entries()].find(
        ([otherId, r]) => otherId !== deepgramSpeakerId && r.voiceSpeakerId === result.speakerId,
      );

      if (priorEntry) {
        const [priorDgramId, priorResolved] = priorEntry;
        resolvedName = priorResolved.label;
        resolvedSpeakerId = priorResolved.speakerId;
        method = 'voice_id';
        this.logger.log(
          `[${client.id}] Speaker ${deepgramSpeakerId} consolidated with prior speaker ${priorDgramId} ("${resolvedName}") — same voice print`,
        );
      } else {
        // 1. Check session roster (voice_speaker_id → local speaker ID)
        const rosterEntry = session.speakerRosterByVoiceId.get(result.speakerId);
        // 2. Fall back to account-wide map (also maps voice_speaker_id → local speaker ID)
        const accountEntry = accountSpeakerByVoiceId.get(result.speakerId);

        if (rosterEntry) {
          resolvedName = rosterEntry.displayName;
          resolvedSpeakerId = rosterEntry.speakerId;          // local speakers.id
        } else if (accountEntry) {
          resolvedName = accountEntry.name;
          resolvedSpeakerId = accountEntry.id;                // local speakers.id
        } else {
          // External name only, no local record — do not store a FK
          resolvedName = result.speakerName ?? anonymousLabel;
          resolvedSpeakerId = null;
        }
        method = 'voice_id';
      }
    } else {
      // No match — mark as failed so the retry loop can re-attempt later
      resolvedName = anonymousLabel;
      session.speakerIdentificationFailed.add(deepgramSpeakerId);
      this.logger.log(
        `[${client.id}] Speaker ${deepgramSpeakerId} identification returned no match ` +
        `(score=${result.similarityScore.toFixed(3)}) — will retry`,
      );
    }

    const resolved: ResolvedSpeaker = {
      speakerId: resolvedSpeakerId,
      label: resolvedName,
      voiceSpeakerId: resolvedVoiceSpeakerId,
      method,
      confidence: result.similarityScore,
    };
    session.resolvedSpeakers.set(deepgramSpeakerId, resolved);

    if (method === 'voice_id') {
      // ── Update in-memory turn history so the AI context uses the correct name
      // immediately — without waiting for the next transcript event to rebuild labels.
      const updateTurn = (t: MultiSpeakerTurn): MultiSpeakerTurn =>
        t.deepgramSpeakerId === deepgramSpeakerId
          ? { ...t, speakerLabel: resolvedName, speakerId: resolvedSpeakerId, identificationMethod: 'voice_id' as const }
          : t;

      session.multiSpeakerHistory = session.multiSpeakerHistory.map(updateTurn);
      session.pendingMultiSpeakerTurns = session.pendingMultiSpeakerTurns.map(updateTurn);

      // ── Retroactively update segment rows saved before identification ─────
      this.conversationService.updateTranscriptSpeakerByDeepgramId({
        conversationId: session.conversationId,
        deepgramSpeakerId,
        speakerId: resolvedSpeakerId,
        speakerLabel: resolvedName,
        identificationMethod: 'voice_id',
        recordingSessionId: session.recordingSessionId,
      }).catch((err) =>
        this.logger.warn(`[${client.id}] retroactive segment update failed (non-fatal): ${(err as Error).message}`),
      );

      // ── Persist the confirmed identity as a durable conversation participant ──
      // This survives provider-session reconnects so the next session:ready
      // can include this speaker in restoredParticipants.
      this.conversationService.upsertConversationParticipant({
        conversationId: session.conversationId,
        userId: session.userId,
        displayName: resolvedName,
        speakerId: resolvedSpeakerId ?? undefined,
        voiceSpeakerId: resolvedVoiceSpeakerId ?? undefined,
        voiceConfirmed: true,
      }).catch((err) =>
        this.logger.warn(`[${client.id}] Failed to persist voice-ID participant: ${(err as Error).message}`),
      );
    }

    client.emit('speaker:identified', {
      deepgramSpeakerId,
      speakerId: resolvedSpeakerId,
      previousLabel: anonymousLabel,
      speakerLabel: resolvedName,
      method,
      ...(result.identified ? { similarityScore: result.similarityScore } : {}),
      audioSource: hasPerSpeakerAudio ? 'per_speaker' : 'mixed',
      persisted: method === 'voice_id',
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Builds transcript turns for multi-speaker mode preserving strict
   * chronological word order.
   *
   * Words are walked in sequence order.  Each time the speaker ID changes a
   * new turn is opened.  This preserves interruptions and interleaved speech —
   * e.g. A-B-A produces three turns: A, B, A.
   *
   * The previous grouping-by-speaker approach collapsed all of speaker A's
   * words into one turn regardless of where speaker B interrupted, corrupting
   * the conversation timeline.
   */
  private buildMultiSpeakerTurns(
    session: ActiveSession,
    words: TranscriptWord[],
    confidence: number,
    fallbackTranscript?: string,
  ): MultiSpeakerTurn[] {
    // Fallback when Deepgram returns no word-level data.
    if (!words.length) {
      if (!fallbackTranscript?.trim()) return [];
      const spkId = session.currentDominantSpeaker ?? 0;
      const identity = this.resolveSpeakerLabel(session, spkId);
      return [{
        deepgramSpeakerId: spkId,
        speakerId: identity.speakerId,
        speakerLabel: identity.speakerLabel,
        text: fallbackTranscript.trim(),
        confidence,
        startMs: null,
        endMs: null,
        identificationMethod: identity.identificationMethod,
      }];
    }

    // Build contiguous speaker runs in word order.
    const runs: { speakerId: number; words: TranscriptWord[] }[] = [];
    let current: { speakerId: number; words: TranscriptWord[] } | null = null;

    for (const word of words) {
      const spk = word.speaker ?? 0;
      if (!current || current.speakerId !== spk) {
        current = { speakerId: spk, words: [word] };
        runs.push(current);
      } else {
        current.words.push(word);
      }
    }

    const turns: MultiSpeakerTurn[] = [];
    for (const run of runs) {
      const text = run.words.map((w) => w.word).join(' ').trim();
      if (!text) continue;

      const identity = this.resolveSpeakerLabel(session, run.speakerId);
      turns.push({
        deepgramSpeakerId: run.speakerId,
        speakerId: identity.speakerId,
        speakerLabel: identity.speakerLabel,
        text,
        confidence,
        startMs: run.words[0]?.start != null ? Math.round(run.words[0].start * 1000) : null,
        endMs: run.words.at(-1)?.end != null ? Math.round(run.words.at(-1)!.end * 1000) : null,
        identificationMethod: identity.identificationMethod,
      });
    }

    return turns;
  }

  /** Returns the current resolved identity for a Deepgram speaker ID (multi-speaker). */
  private resolveSpeakerLabel(
    session: ActiveSession,
    deepgramSpeakerId: number,
  ): {
    speakerId: string | null;
    speakerLabel: string;
    voiceSpeakerId: string | null;
    identificationMethod: 'voice_id' | 'manual' | 'diarization' | 'unknown';
    confidence?: number;
  } {
    const resolved = session.resolvedSpeakers.get(deepgramSpeakerId);
    if (resolved) {
      return {
        speakerId: resolved.speakerId,
        speakerLabel: resolved.label,
        voiceSpeakerId: resolved.voiceSpeakerId,
        identificationMethod: resolved.method,
        confidence: resolved.confidence,
      };
    }

    return {
      speakerId: null,
      speakerLabel: this.getAnonymousSpeakerLabel(session, deepgramSpeakerId),
      voiceSpeakerId: null,
      identificationMethod: 'diarization',
    };
  }

  /** Returns a stable session-local anonymous label (Guest 1, Guest 2 …) for an unresolved speaker. */
  private getAnonymousSpeakerLabel(session: ActiveSession, deepgramSpeakerId: number): string {
    const existing = session.anonymousSpeakerLabels.get(deepgramSpeakerId);
    if (existing) return existing;

    const label = `Guest ${session.nextAnonymousSpeakerNumber}`;
    session.nextAnonymousSpeakerNumber += 1;
    session.anonymousSpeakerLabels.set(deepgramSpeakerId, label);
    return label;
  }

  /** Resolves and validates the session speaker roster against the user's saved speakers. */
  private async resolveSpeakerRoster(
    userId: string,
    roster?: Array<{ speakerId: string; displayName: string; role?: 'owner' | 'participant' }>,
  ): Promise<SpeakerRosterEntry[]> {
    if (!roster?.length) return [];

    const allSpeakers = await this.speakersService.getUserSpeakers(userId);
    const byId = new Map(allSpeakers.map((s) => [s.id, s]));

    return roster
      .map((entry): SpeakerRosterEntry | null => {
        const speaker = byId.get(entry.speakerId);
        if (!speaker) return null;
        return {
          speakerId: speaker.id,
          displayName: entry.displayName || speaker.name,
          voiceSpeakerId: speaker.voice_speaker_id,
          role: entry.role ?? (speaker.is_owner ? 'owner' : 'participant'),
        };
      })
      .filter((e): e is SpeakerRosterEntry => Boolean(e));
  }

  /** Builds DB rows for multi-speaker transcript turns. */
  private buildMultiSpeakerSegmentDtos(
    session: ActiveSession,
    turns: MultiSpeakerTurn[],
  ): SaveTranscriptSegmentDto[] {
    return turns.map((t) => ({
      conversationId: session.conversationId,
      messageId: null,
      speakerId: t.speakerId,
      deepgramSpeakerId: t.deepgramSpeakerId,
      speakerLabel: t.speakerLabel,
      transcript: t.text,
      startMs: t.startMs,
      endMs: t.endMs,
      confidence: t.confidence,
      identificationMethod: t.identificationMethod,
      recordingSessionId: session.recordingSessionId,
    }));
  }

  /** Counts total words across all pending multi-speaker turns. */
  private countTurnWords(turns: MultiSpeakerTurn[]): number {
    return turns
      .map((t) => t.text)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
  }

  /**
   * Drains `pendingMultiSpeakerTurns` and fires `processMultiSpeakerPrompt`.
   * Returns true if a prompt was dispatched, false if skipped.
   * Short turns (< minWords) are KEPT in the queue so they can accumulate
   * with the next utterance instead of being silently discarded.
   */
  private async flushMultiSpeakerTurns(
    client: Socket,
    session: ActiveSession,
    options: { minWords?: number; reason: 'utterance_end' | 'audio_stop' | 'session_end' },
  ): Promise<boolean> {
    if (!session.isMultiSpeaker) return false;

    if (session.isProcessingAI) {
      client.emit('ai:skipped', { reason: 'already_processing' });
      return false;
    }

    const turns = [...session.pendingMultiSpeakerTurns];
    if (turns.length === 0) {
      if (options.reason !== 'utterance_end') {
        client.emit('ai:skipped', { reason: 'empty_transcript' });
      }
      return false;
    }

    const wordCount = this.countTurnWords(turns);
    const minWords = options.minWords ?? 8;

    if (wordCount < minWords) {
      // Do NOT splice — keep turns so the next utterance can accumulate with them.
      if (options.reason !== 'utterance_end') {
        client.emit('ai:skipped', {
          reason: 'too_short',
          mode: 'multiple_speaker',
          transcript: turns.map((t) => t.text).join(' '),
          segments: turns,
        });
      }
      return false;
    }

    // Commit the drain only after threshold is confirmed
    session.pendingMultiSpeakerTurns = [];
    session.accumulatedTranscript = '';
    session.transcriptConfidences = [];
    client.emit('transcript:update', {
      mode: 'multiple_speaker',
      transcript: '',
      isFinal: true,
      cleared: true,
    });

    await this.processMultiSpeakerPrompt(client, session, turns);
    return true;
  }

  // ─── Provider connection lifecycle (bounded recovery) ────────────────────────

  /**
   * Registers the Deepgram event handlers for the session's *current*
   * provider connection. Called once at session:start and again after each
   * successful recovery reconnect (against the new emitter). `epoch` is
   * snapshotted at registration time so a stale event from an
   * already-replaced connection can be detected and ignored.
   */
  private attachDeepgramListeners(client: Socket, session: ActiveSession, emitter: EventEmitter): void {
    const epoch = session.providerEpoch;
    const shouldDiarize = session.isDualSpeaker || session.isMultiSpeaker;

    // ── Deepgram transcript handler ───────────────────────────────────────
    emitter.on('transcript', (result) => {
      if (!result.isFinal) {
        if (!shouldDiarize) {
          session.pendingInterimTranscript = result.transcript;
        }
        client.emit('transcript:update', {
          transcript: (session.accumulatedTranscript + ' ' + result.transcript).trim(),
          isFinal: false,
          confidence: result.confidence,
        });
        return;
      }

      session.pendingInterimTranscript = '';

      if (typeof result.confidence === 'number') {
        session.transcriptConfidences.push(result.confidence);
      }

      // ── Multi-speaker path ────────────────────────────────────────────
      if (session.isMultiSpeaker) {
        const words: TranscriptWord[] = result.words ?? [];
        const turns = this.buildMultiSpeakerTurns(session, words, result.confidence, result.transcript);

        // Track per-speaker accumulated speech duration
        for (const w of words) {
          const spk = w.speaker ?? 0;
          const dur = (w.end ?? 0) - (w.start ?? 0);
          session.speakerWordSeconds.set(spk, (session.speakerWordSeconds.get(spk) ?? 0) + dur);
        }

        // Update dominant speaker for audio tagging
        const dominantInResult = words.reduce((acc, w) => {
          const spk = w.speaker ?? 0;
          acc.set(spk, (acc.get(spk) ?? 0) + 1);
          return acc;
        }, new Map<number, number>());
        if (dominantInResult.size > 0) {
          session.currentDominantSpeaker = [...dominantInResult.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }

        session.multiSpeakerHistory.push(...turns);
        session.pendingMultiSpeakerTurns.push(...turns);
        session.accumulatedTranscript = turns.map((t) => t.text).join(' ');

        // Trigger per-speaker identification (first attempt + retry on prior failure)
        if (!session.isGuest && this.voiceVerificationService.isEnabled) {
          for (const [spkId, seconds] of session.speakerWordSeconds.entries()) {
            const alreadyTriggered = session.speakerIdentificationTriggered.has(spkId);
            const prevFailed = session.speakerIdentificationFailed.has(spkId);
            const attemptedAtSeconds = session.speakerIdentificationAtSeconds.get(spkId) ?? 0;

            const isFirstAttempt = !alreadyTriggered && seconds >= this.SPEAKER_IDENTIFICATION_THRESHOLD_S;
            // Retry after a failed attempt once they've spoken RETRY_IDENTIFICATION_EXTRA_S
            // more seconds since the last attempt — avoids thrashing on poor-audio windows.
            const isRetry = alreadyTriggered && prevFailed &&
              seconds >= attemptedAtSeconds + this.RETRY_IDENTIFICATION_EXTRA_S;

            if (isFirstAttempt || isRetry) {
              session.speakerIdentificationTriggered.add(spkId);
              session.speakerIdentificationFailed.delete(spkId);
              session.speakerIdentificationAtSeconds.set(spkId, seconds);
              this.identifyMultiSpeaker(client, session, spkId).catch((err) =>
                this.logger.error(`[${client.id}] identifyMultiSpeaker error (speaker ${spkId}):`, err),
              );
            }
          }
        }

        // Trigger backend calibration
        if (!session.voiceCalibrationTriggered && !session.isGuest) {
          const totalSpeech = [...session.speakerWordSeconds.values()].reduce((a, b) => a + b, 0);
          if (totalSpeech >= this.CALIBRATION_SPEECH_THRESHOLD_S && session.audioBuffer.length > 0) {
            session.voiceCalibrationTriggered = true;
            this.autoVoiceCalibration(client, session).catch((err) =>
              this.logger.error(`[${client.id}] Auto voice calibration error:`, err),
            );
          }
        }

        client.emit('transcript:update', {
          mode: 'multiple_speaker',
          isFinal: true,
          confidence: result.confidence,
          transcript: session.accumulatedTranscript,
          segments: turns,
        });
        return;
      }

      // ── Dual-speaker path ─────────────────────────────────────────────
      if (session.isDualSpeaker) {
        const words: TranscriptWord[] = result.words ?? [];
        const speakerTexts = new Map<number, string>();
        for (const w of words) {
          const spk = w.speaker ?? 0;
          speakerTexts.set(spk, ((speakerTexts.get(spk) ?? '') + ' ' + w.word).trim());
        }

        const dominantInResult = [...speakerTexts.entries()]
          .sort((a, b) => b[1].length - a[1].length)[0]?.[0];
        if (dominantInResult !== undefined) {
          session.currentDominantSpeaker = dominantInResult;
        }

        for (const w of words) {
          const spk = w.speaker ?? 0;
          const dur = (w.end ?? 0) - (w.start ?? 0);
          session.speakerWordSeconds.set(spk, (session.speakerWordSeconds.get(spk) ?? 0) + dur);
        }

        if (!session.calibrationPhase && !session.isGuest && this.voiceVerificationService.isEnabled) {
          for (const [spkId, seconds] of session.speakerWordSeconds.entries()) {
            const alreadyTriggered = session.speakerIdentificationTriggered.has(spkId);
            const prevFailed = session.speakerIdentificationFailed.has(spkId);
            const attemptedAtSeconds = session.speakerIdentificationAtSeconds.get(spkId) ?? 0;

            const isFirstAttempt = !alreadyTriggered && seconds >= this.SPEAKER_IDENTIFICATION_THRESHOLD_S;
            const isRetry = alreadyTriggered && prevFailed &&
              seconds >= attemptedAtSeconds + this.RETRY_IDENTIFICATION_EXTRA_S;

            if (isFirstAttempt || isRetry) {
              session.speakerIdentificationTriggered.add(spkId);
              session.speakerIdentificationFailed.delete(spkId);
              session.speakerIdentificationAtSeconds.set(spkId, seconds);
              this.identifyDualSpeaker(client, session, spkId).catch((err) =>
                this.logger.error(`[${client.id}] identifyDualSpeaker error (speaker ${spkId}):`, err),
              );
            }
          }
        }

        if (session.calibrationPhase && words.length >= 3) {
          const wordCounts = new Map<number, number>();
          for (const w of words) {
            const spk = w.speaker ?? 0;
            wordCounts.set(spk, (wordCounts.get(spk) ?? 0) + 1);
          }
          const sorted = [...wordCounts.entries()].sort((a, b) => b[1] - a[1]);
          const dominantSpeaker = sorted[0][0];
          const totalWords = [...wordCounts.values()].reduce((a, b) => a + b, 0);
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

        if (!session.voiceCalibrationTriggered && !session.isGuest) {
          const totalSpeech = [...session.speakerWordSeconds.values()].reduce((a, b) => a + b, 0);
          if (totalSpeech >= this.CALIBRATION_SPEECH_THRESHOLD_S && session.audioBuffer.length > 0) {
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

        session.accumulatedTranscript =
          (session.accumulatedTranscript + ' ' + result.transcript).trim();

        client.emit('transcript:update', {
          transcript: session.accumulatedTranscript,
          isFinal: true,
          confidence: result.confidence,
          speakers: Object.fromEntries(
            Array.from(speakerTexts.entries()).map(([id, text]) => [
              id === ownerSpk ? 'owner' : 'other',
              text,
            ]),
          ),
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

    // ── Debounced Claude trigger ──────────────────────────────────────────
    emitter.on('utteranceEnd', () => {
      if (session.isProcessingAI) return;

      if (session.utteranceDebounceTimer) {
        clearTimeout(session.utteranceDebounceTimer);
        session.utteranceDebounceTimer = null;
      }

      session.utteranceDebounceTimer = setTimeout(async () => {
        session.utteranceDebounceTimer = null;
        if (session.isProcessingAI) return;

        // ── Multi-speaker path ──────────────────────────────────────────
        if (session.isMultiSpeaker) {
          await this.flushMultiSpeakerTurns(client, session, {
            reason: 'utterance_end',
            minWords: 8,
          });
          return;
        }

        // ── Dual-speaker path ───────────────────────────────────────────
        if (session.isDualSpeaker) {
          if (session.calibrationPhase) return;

          const otherText = session.pendingOtherText.trim();
          const ownerText = session.pendingOwnerText.trim();

          const combinedWords = `${ownerText} ${otherText}`
            .trim()
            .split(/\s+/)
            .filter(Boolean).length;

          if (combinedWords < 8) return;

          session.pendingOtherText = '';
          session.pendingOwnerText = '';
          session.accumulatedTranscript = '';
          client.emit('transcript:update', { transcript: '', isFinal: true, cleared: true });

          const primaryText = otherText || ownerText;
          const contextText = otherText ? ownerText : '';
          const speakerDetected = Boolean(otherText);

          await this.processDualSpeakerPrompt(client, session, primaryText, contextText, speakerDetected);
          return;
        }

        // ── Single-speaker path ─────────────────────────────────────────
        const transcript = session.accumulatedTranscript.trim();
        if (!transcript) return;

        const wordCount = transcript.split(/\s+/).filter(Boolean).length;
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

    // ── Provider disruption routing ───────────────────────────────────────
    // All three funnel into the same bounded-recovery orchestration. `epoch`
    // is the epoch this connection was registered under, so a late event
    // from a connection that recovery has already replaced is ignored.
    emitter.on('error', () => {
      this.handleProviderDisruption(client, session, epoch, 'deepgram_error');
    });
    emitter.on('close', (closeInfo: ProviderCloseInfo) => {
      this.handleProviderDisruption(client, session, epoch, 'deepgram_closed', closeInfo);
    });
    emitter.on('transportFailure', ({ source, error }: { source: string; error: Error }) => {
      this.logger.warn(`[${client.id}] provider transport failure (${source}) epoch=${epoch}: ${error.message}`);
      this.handleProviderDisruption(client, session, epoch, 'transport_failure');
    });
  }

  /** Entry guard shared by the three provider-disruption events. */
  private handleProviderDisruption(
    client: Socket,
    session: ActiveSession,
    epoch: number,
    reason: ProviderDisruptionReason,
    closeInfo: ProviderCloseInfo | null = null,
  ): void {
    if (!this.sessions.has(client.id)) return;
    void this.recoverProviderSession(client, session, epoch, reason, closeInfo);
  }

  /**
   * Bounded, provider-only reconnect. Preserves the outer application/
   * conversation session — only the Deepgram connection is replaced.
   * Detect → Quiesce → Notify → Reconnect → Resume → Escalate.
   */
  private async recoverProviderSession(
    client: Socket,
    session: ActiveSession,
    epoch: number,
    reason: ProviderDisruptionReason,
    closeInfo: ProviderCloseInfo | null,
  ): Promise<void> {
    // Detect/dedupe — synchronous, before any await. A stale epoch means this
    // event came from a connection recovery already replaced; a non-'active'
    // state means a recovery sequence is already running (or finished) for
    // this epoch, e.g. an 'error' immediately followed by a 'close' for the
    // same disruption — collapse both into a single recovery sequence.
    if (session.providerEpoch !== epoch) return;
    if (session.providerState !== 'active') return;
    session.providerState = 'recovering';

    // Quiesce — tear down the dead connection defensively. closeDeepgram()
    // only acts while the socket is OPEN, so this is a safe no-op if the
    // connection is already gone.
    session.deepgramEmitter.removeAllListeners();
    try { session.closeDeepgram(); } catch (_) {}

    const recoveryId = randomUUID();
    session.currentRecoveryId = recoveryId;
    session.recoveryAttempt = 0;

    this.logger.warn(
      `[${client.id}] provider disruption (${reason}) — starting recovery ${recoveryId} ` +
      `closeCode=${closeInfo?.code ?? 'n/a'} closeReason=${closeInfo?.reason ?? 'n/a'} errorPreceded=${closeInfo?.errorPreceded ?? 'n/a'}`,
    );

    // Notify — emitted exactly once per recovery sequence, not per attempt.
    client.emit('session:recovering', {
      recoveryId,
      reason,
      attempt: 1,
      maxAttempts: PROVIDER_RECOVERY_MAX_ATTEMPTS,
      recoverable: true,
    });

    for (let attempt = 1; attempt <= PROVIDER_RECOVERY_MAX_ATTEMPTS; attempt++) {
      if (!this.sessions.has(client.id) || session.providerState !== 'recovering') return;
      session.recoveryAttempt = attempt;

      if (attempt > 1) {
        await sleep(computeBackoffDelayMs(attempt - 1));
        if (!this.sessions.has(client.id) || session.providerState !== 'recovering') return;
      }

      try {
        const { emitter, sendAudio, sendFinalize, close } = await this.deepgramService.createLiveSession(
          `${client.id}:e${session.providerEpoch + 1}`,
          { ...session.providerConnectOptions, connectionTimeoutMs: 5_000 },
        );

        // The session may have been torn down (disconnect/session:end) while
        // this connect attempt was in flight — discard the fresh connection
        // cleanly rather than attaching it to a dead session.
        if (!this.sessions.has(client.id) || session.providerState !== 'recovering') {
          try { close(); } catch (_) {}
          return;
        }

        session.deepgramEmitter = emitter;
        session.sendAudio = sendAudio;
        session.sendFinalize = sendFinalize;
        session.closeDeepgram = close;
        session.providerEpoch += 1;
        this.attachDeepgramListeners(client, session, emitter);

        const { droppedDurationMs } = this.flushRecoveryBuffer(session);

        session.providerState = 'recovered';
        session.currentRecoveryId = null;

        this.logger.log(
          `[${client.id}] provider recovery ${recoveryId} succeeded on attempt ${attempt} ` +
          `(epoch=${session.providerEpoch}, droppedDurationMs=${droppedDurationMs})`,
        );

        client.emit('session:recovered', {
          recoveryId,
          providerEpoch: session.providerEpoch,
          audioGapDetected: droppedDurationMs > 0,
          droppedDurationMs,
        });
        return;
      } catch (err) {
        this.logger.warn(
          `[${client.id}] provider recovery ${recoveryId} attempt ${attempt}/${PROVIDER_RECOVERY_MAX_ATTEMPTS} failed: ${(err as Error).message}`,
        );
      }
    }

    // Escalate — retry budget exhausted.
    if (!this.sessions.has(client.id)) return;

    const incidentId = randomUUID();
    session.providerState = 'failed';

    this.errorLogService.log({
      source: 'voice_gateway',
      code: 'PROVIDER_RECOVERY_EXHAUSTED',
      message: `Provider recovery exhausted after ${PROVIDER_RECOVERY_MAX_ATTEMPTS} attempts`,
      severity: 'error',
      context: {
        socketId: client.id,
        recoveryId,
        incidentId,
        providerEpoch: session.providerEpoch,
        reason,
        closeCode: closeInfo?.code ?? null,
      },
    });

    client.emit('session:degraded', {
      recoveryId,
      reason: 'provider_recovery_exhausted',
      category: 'provider_recovery_failed',
      recoverable: false,
      incidentId,
      message: 'We could not restore your voice connection after several attempts. Please start a new recording.',
    });

    this.cleanupSession(client.id);
  }

  /** Buffers one audio chunk while providerState === 'recovering', bounded by both byte count and age. */
  private bufferAudioForRecovery(session: ActiveSession, buffer: Buffer): void {
    const now = Date.now();

    while (
      session.recoveryAudioBuffer.length > 0 &&
      now - session.recoveryAudioBuffer[0].enqueuedAt > this.PROVIDER_RECOVERY_BUFFER_MAX_MS
    ) {
      const dropped = session.recoveryAudioBuffer.shift()!;
      session.recoveryAudioBufferBytes -= dropped.chunk.length;
    }

    if (session.recoveryAudioBufferBytes + buffer.length > this.PROVIDER_RECOVERY_BUFFER_MAX_BYTES) {
      // Byte cap reached — drop this (newest) chunk so the buffer keeps
      // replaying audio closest to the moment the outage started.
      if (session.recoveryBufferOverflowStartedAt === null) {
        session.recoveryBufferOverflowStartedAt = now;
      }
      return;
    }

    session.recoveryAudioBuffer.push({ chunk: buffer, enqueuedAt: now });
    session.recoveryAudioBufferBytes += buffer.length;
  }

  /** Replays the bounded recovery buffer to the newly-reconnected provider and clears it. */
  private flushRecoveryBuffer(session: ActiveSession): { flushedBytes: number; droppedDurationMs: number } {
    let flushedBytes = 0;
    for (const { chunk } of session.recoveryAudioBuffer) {
      session.sendAudio(chunk);
      flushedBytes += chunk.length;
    }

    const droppedDurationMs = session.recoveryBufferOverflowStartedAt !== null
      ? Date.now() - session.recoveryBufferOverflowStartedAt
      : 0;

    session.recoveryAudioBuffer = [];
    session.recoveryAudioBufferBytes = 0;
    session.recoveryBufferOverflowStartedAt = null;

    return { flushedBytes, droppedDurationMs };
  }

  private cleanupSession(socketId: string): void {
    const session = this.sessions.get(socketId);
    if (!session) return;

    // Marked first, before anything else: any provider 'error'/'close'/
    // 'transportFailure' already in flight for this session will see this on
    // its next synchronous check and no-op instead of starting recovery or
    // reporting an unexpected drop — this is what makes an intentional
    // teardown (session:end, idle timeout, disconnect) distinguishable from
    // a genuine provider failure. Exception: recoverProviderSession's own
    // escalate step sets 'failed' and then calls cleanupSession itself as
    // its final teardown — don't overwrite that with 'intentionally_closed',
    // the disruption was real, not an intentional stop.
    if (session.providerState !== 'failed') {
      session.providerState = 'intentionally_closed';
    }

    this.sessions.delete(socketId);
    session.deepgramEmitter.removeAllListeners();

    if (session.utteranceDebounceTimer) {
      clearTimeout(session.utteranceDebounceTimer);
      session.utteranceDebounceTimer = null;
    }
    if (session.idleTimeoutHandle) {
      clearTimeout(session.idleTimeoutHandle);
      session.idleTimeoutHandle = null;
    }

    session.audioBuffer = [];
    session.audioBufferBytes = 0;
    session.speakerAudioBuffers.clear();
    session.speakerAudioBytes.clear();
    session.resolvedSpeakers.clear();
    session.anonymousSpeakerLabels.clear();
    session.recoveryAudioBuffer = [];
    session.recoveryAudioBufferBytes = 0;

    session.closeDeepgram();
    this.logger.log(`Session cleaned up: ${socketId}`);
  }
}
