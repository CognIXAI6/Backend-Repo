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
import { Logger, BeforeApplicationShutdown, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import { DeepgramLiveAudioFormat, DeepgramService, TranscriptWord } from './services/deepgram.service';
import { ClaudeService, ConversationImage as ClaudeConversationImage } from './services/claude.service';
import { ConversationService, ConversationMode, SaveTranscriptSegmentDto, ConversationParticipant, ConversationMessage, UpsertParticipantDto, ConversationImage as DbConversationImage } from './services/conversation.service';
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
import { wrapPcm16AsWav } from './utils/pcm-wav.util';
import { buildCombinedSummary } from './utils/combined-summary.util';
import { EntitlementsService } from '@/modules/entitlements/entitlements.service';
import { UsageService } from '@/modules/entitlements/usage.service';
import { RecordingTimingService } from './services/recording-timing.service';
import { countWords, describeError } from '@/common/utils/log-safe.util';
import { SummaryEmailReason, classifyEmailError } from './utils/summary-email-status.util';
import { ContextCoverage, ContextPlan, SUMMARY_CONTEXT_BOUNDS, planSummaryContext, raceDeadline } from './utils/summary-context.util';
import {
  AudioLossReason,
  SessionCorrelation,
  SessionTerminalReason,
  providerDisruptionCause,
} from './utils/session-lifecycle.util';
import {
  BoundKind,
  SESSION_BOUNDS,
  SessionMetrics,
  createSessionMetrics,
  recordHighWater,
  snapshotMetrics,
} from './utils/session-metrics.util';
import { PlanEntitlements, PlanType } from '@/modules/entitlements/entitlements.types';
import { SettingsService } from '@/modules/settings/settings.service';
import { buildUnclearFallback, buildDocumentReadyFallback } from './constants/fallback-messages.constant';

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
  /** 'unknown' = recognised text for which the provider reported no word-level speaker. */
  speaker: 'owner' | 'other' | 'unknown';
  text: string;
}

interface SpeakerRosterEntry {
  speakerId: string;
  displayName: string;
  voiceSpeakerId: string | null;
  role: 'owner' | 'participant';
}

interface MultiSpeakerTurn {
  /** null = the provider gave no word-level speaker data for this text (attribution unknown). */
  deepgramSpeakerId: number | null;
  /** Provider connection the speaker number belongs to (numbering can restart on reconnect). */
  providerEpoch?: number;
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
  /** The field this conversation is stored under (authoritative for live prompts); null = none. */
  fieldId?: string | null;
  /** AI turns currently being processed — awaited before the session summary so a final turn isn't missed. */
  inFlightTurns: Set<Promise<unknown>>;
  /** In-memory turn sequence: turns accepted for processing vs. settled (for ordering/diagnostics; not persisted). */
  acceptedTurnSeq: number;
  settledTurnSeq: number;
  /** Memory/queue high-water marks and bound hits (counts and bytes only). */
  metrics: SessionMetrics;
  /** Server-generated per session:start — correlates every lifecycle log/event of this session. */
  traceId: string;
  /** Ack boundary: the last audio sequence acknowledged, and on which stream. */
  lastAckedSequence: number | null;
  lastAckedStreamId: string | null;
  /** Logical recording-session id registered via session:timing:start (authenticated sessions only). */
  timingSessionId?: string;
  /** Serialises session:timing:* operations and the close on end/disconnect, in arrival order. */
  timingChain?: Promise<unknown>;
  isGuest: boolean;
  /** Only set for guest sessions */
  guestSessionId?: string;
  /** Wall-clock ms this session's Deepgram connection opened — used to meter voice-minutes usage on teardown. Guests don't consume a tier's voice-minute cap. */
  startedAt: number;
  /** Resolved once at session:start; undefined for guest sessions. */
  tier?: PlanType;
  entitlements?: PlanEntitlements;
  deepgramEmitter: EventEmitter;
  /** Returns false when the provider socket could not accept the chunk (not OPEN / send threw). */
  sendAudio: (chunk: Buffer) => boolean | void;
  sendFinalize: () => boolean | void;
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
  /** Recognised dual-speaker text with no word-level speaker data — kept, never guessed into owner/other. */
  pendingUnattributedText: string;
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
  recoveryAudioBuffer: Array<{ chunk: Buffer; enqueuedAt: number; streamId?: string; sequence?: number }>;
  /** Audio the recovery buffer could not keep, accumulated until the next (throttled) audio:loss event. */
  pendingLoss?: { streamId: string | null; firstSequence: number | null; lastSequence: number | null; chunks: number; bytes: number };
  lastLossEmitAt?: number;
  recoveryAudioBufferBytes: number;
  /** Wall-clock timestamp when overflow-driven dropping started this recovery cycle; null when not currently dropping. */
  recoveryBufferOverflowStartedAt: number | null;
  /** Bytes of audio dropped from the recovery buffer (byte cap / age) during the current outage — reported, never silent. */
  recoveryDroppedBytes: number;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

/** Label for recognised text whose speaker the provider did not report. */
const UNATTRIBUTED_SPEAKER_LABEL = 'Unknown speaker';

/** Upper bound Stop waits for an AI turn that is already being processed. */
const IN_FLIGHT_TURN_WAIT_MS = 20_000;
type SummaryFailureReason = 'context_too_large' | 'generation_timeout' | 'generation_error';
const SUMMARY_FAILURE_MESSAGES: Record<SummaryFailureReason, string> = {
  context_too_large: 'This conversation is too long to summarise automatically.',
  generation_timeout: 'Summary generation took too long. It will be retried the next time you stop this conversation.',
  generation_error: "We couldn't generate your conversation summary.",
};

/** Safety cap on wait→flush→wait rounds at one stop boundary. */
const MAX_DRAIN_PASSES = 4;

@WebSocketGateway({
  namespace: '/voice',
  cors: { origin: true, credentials: true },
  pingTimeout: 60_000,
  pingInterval: 25_000,
})
export class VoiceGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, BeforeApplicationShutdown {
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
   * Grace period before a raw socket drop triggers the auto-summary. A phone
   * lock / network blip is followed by a reconnect with the same
   * conversationId; summarising immediately sent one summary email per drop.
   * An explicit session:end still summarises immediately.
   */
  private readonly DISCONNECT_SUMMARY_GRACE_MS = 90_000;
  /** conversationId → pending deferred summary (cancelled if the client resumes). */
  private readonly pendingDisconnectSummaries = new Map<string, ReturnType<typeof setTimeout>>();

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
    private readonly entitlementsService: EntitlementsService,
    private readonly usageService: UsageService,
    private readonly settingsService: SettingsService,
    @Optional() private readonly recordingTimingService?: RecordingTimingService,
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

  // Dedicated event (distinct from the generic 'error' emitError sends)
  // so the client can route this to an upgrade prompt, the same way it
  // already does for the existing 'guest:limit_reached' event.
  private emitEntitlementBlocked(
    client: Socket,
    reason: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): void {
    // This used to be silent server-side — a blocked session:start looked
    // identical in the logs to a client that simply vanished (connect, then
    // disconnect with nothing in between), which made the free-tier
    // dual/multi-speaker block indistinguishable from an actual backend hang.
    this.logger.log(`[${client.id}] entitlement:blocked — reason=${reason} extra=${JSON.stringify(extra)}`);
    client.emit('entitlement:blocked', { reason, message, ...extra });
  }

  // Deliberately NOT routed through emitEntitlementBlocked / 'entitlement:blocked':
  // that event's existing client handler treats it as a voice/session block and
  // stops capture. A blocked web search is not a failure of the turn — the AI
  // still answers (from training knowledge, per the tool_result it's given) —
  // so it gets its own event and must never be confused with a real block.
  private emitFeatureUnavailable(
    client: Socket,
    payload: {
      feature: 'web_search';
      reason: 'quota_exhausted' | 'plan_excluded';
      message: string;
      used?: number;
      limit?: number | null;
      conversationId: string;
      turnId: string;
    },
  ): void {
    this.logger.log(
      `[${client.id}] feature:unavailable — feature=${payload.feature} reason=${payload.reason} turnId=${payload.turnId}`,
    );
    client.emit('feature:unavailable', payload);
  }

  /**
   * Read-only check (does not consume) run at every entry point that's
   * about to call processPrompt for an authenticated turn. The actual
   * consumption happens once, inside processPrompt's onDone, so a turn
   * that errors out before completing never burns a message — same
   * fairness guestSessionService's increment-on-completion already gives
   * guests. Guests are gated by the existing guest_sessions path, not this.
   */
  private async checkMessageQuota(client: Socket, session: ActiveSession): Promise<boolean> {
    if (session.isGuest || !session.entitlements) return true;

    const status = await this.usageService.getStatus(
      session.userId,
      'messages',
      session.entitlements.maxMessagesPerMonth,
    );

    if (!status.canUse) {
      this.emitEntitlementBlocked(
        client,
        'messages_exhausted',
        `You've used all ${status.limit} messages included in your plan this month. Upgrade for more.`,
        { used: status.used, limit: status.limit },
      );
      return false;
    }

    return true;
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
        .catch((e) => this.logger.error(`Failed to send admin alert email: ${describeError(e)}`));
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

  /**
   * This process runs single-instance, fork-mode under PM2 (see
   * ecosystem.config.js — session state lives in `sessions`, this process's
   * memory, with no cross-instance sharing set up) by deliberate design, so
   * a deploy's `pm2 reload`/`restart` can't be true zero-downtime the way
   * cluster mode is for the stateless REST API: there's no second instance
   * to hand live connections off to. Before, that meant every connected
   * socket just vanished mid-session with no signal at all — indistinguishable
   * from a random network drop, which is what left the mic UI "rolling"
   * with nothing behind it after a restart.
   *
   * This can't make the restart itself zero-downtime, but it can make it
   * recognizable: broadcast a distinct event so a client that's listening
   * for it can show "reconnecting" and stop the mic, instead of hanging.
   * Nest calls this (and awaits it, since it's async) on SIGTERM/SIGINT
   * — i.e. every `pm2 reload`/`restart`/`stop` — before the underlying
   * HTTP/WS server actually closes; app.enableShutdownHooks() in
   * main-gateway.ts is what wires that up. The brief sleep gives the
   * emit a moment to actually leave the process before the socket server
   * closes (paired with a bumped `kill_timeout` in ecosystem.config.js).
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (this.sessions.size === 0) return;

    this.logger.warn(
      `beforeApplicationShutdown(${signal}) — notifying ${this.sessions.size} active voice session(s) before restart`,
    );
    for (const active of this.sessions.values()) {
      this.logLifecycle(active, 'session_terminal', { reason: 'server_restart' satisfies SessionTerminalReason });
    }
    this.server.emit('server:restarting', {
      reason: 'server_restart' satisfies SessionTerminalReason,
      message: 'The server is restarting for a brief update. Please reconnect in a few seconds.',
    });
    await sleep(500);
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

  // A "stop" that reaches us as a raw socket drop (app closed, network
  // loss, or a client that tears down the connection instead of emitting
  // session:end first) must still get the same auto-summary treatment as
  // an explicit session:end — otherwise the conversation stop silently lost
  // its moment to generate anything. Read the session out of the map BEFORE
  // cleanupSession deletes it; if session:end already ran for this socket
  // (the normal "stop button" path), the session is already gone here and
  // this whole block is a no-op — never a double-generate.
  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`Client disconnected: ${client.id}`);
    const session = this.sessions.get(client.id);

    // Same ordering requirement as handleSessionEnd: drain before cleanupSession
    // clears the buffers it reads.
    const drain = session ? await this.drainSessionTurns(client, session, 'disconnect') : { complete: true };
    if (session) this.logLifecycle(session, 'session_terminal', { reason: 'client_disconnect' satisfies SessionTerminalReason, drainComplete: drain.complete });

    if (session && !session.isGuest) {
      this.scheduleDisconnectSummary(client, session, drain.complete);
      // Unexpected drop: close this socket's timing session as interrupted
      // (partial). A reconnect re-registers the same logical id and resumes it.
      if (this.recordingTimingService) {
        void this.enqueueTiming(session, () => this.recordingTimingService!.closeBySocket({
          conversationId: session.conversationId,
          socketId: client.id,
          status: 'interrupted',
        }));
      }
    }

    this.cleanupSession(client.id);
  }

  private scheduleDisconnectSummary(client: Socket, session: ActiveSession, drainComplete = true): void {
    const { conversationId } = session;
    this.cancelPendingDisconnectSummary(conversationId);
    const timer = setTimeout(() => {
      this.pendingDisconnectSummaries.delete(conversationId);
      this.finalizeSessionOnExit(client, session, { drainComplete }).catch((err) =>
        this.logger.error(`Auto-summary on disconnect failed for conversation ${conversationId}:`, err),
      );
    }, this.DISCONNECT_SUMMARY_GRACE_MS);
    this.pendingDisconnectSummaries.set(conversationId, timer);
  }

  private cancelPendingDisconnectSummary(conversationId: string): void {
    const timer = this.pendingDisconnectSummaries.get(conversationId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingDisconnectSummaries.delete(conversationId);
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
        const guestStatus = await this.guestSessionService.getStatus(payload.guestSessionId);
        // getStatus resolves to a fresh valid UUID when the client-supplied
        // id wasn't one (see GuestSessionService.resolveId) — everything
        // downstream (pseudo userId, conversations, the increment call in
        // processPrompt's onDone) must use that resolved id consistently,
        // not the possibly-invalid one the client sent.
        guestSessionId = guestStatus.id;
        userId = guestSessionId;
        isGuest = true;

        client.emit('guest:status', {
          used: guestStatus.used,
          limit: guestStatus.limit,
          remaining: guestStatus.remaining,
          // Only present when it differs from what the client sent — an
          // up-to-date client ignores an unknown field; one that's been
          // updated to look for it can persist the corrected id so it
          // stops minting a fresh (and fresh-trial) id every session.
          ...(guestStatus.id !== payload.guestSessionId ? { resolvedGuestSessionId: guestStatus.id } : {}),
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
          this.logger.warn(`session:start: conversation ${conversationId} not owned by caller — creating new`);
          conversationId = undefined;
        }
      }

      // ── Resolve the ONE field this conversation lives under ──────────────
      // Never trust a client-supplied field ID/name pair:
      //  • resumed conversation → its persisted field_id is authoritative (history is
      //    not silently reclassified; a different requested field is only FLAGGED so the
      //    client can start a new conversation for a deliberate field boundary);
      //  • new conversation     → the requested field ID if this user may use it (name
      //    always taken from the record), else the account's primary field;
      //  • guests               → only a built-in field matched by name, never free text.
      const requestedFieldId =
        typeof payload.fieldId === 'string' && payload.fieldId.trim() ? payload.fieldId.trim() : null;
      let fieldId: string | null = null;
      let resolvedFieldName: string | undefined;
      let fieldSource: 'conversation' | 'requested' | 'primary' | 'none' = 'none';
      let fieldFallback = false;
      let fieldMismatch = false;

      if (conversationId) {
        const persistedFieldId = await this.conversationService.getConversationFieldId(conversationId, userId);
        fieldId = persistedFieldId;
        if (persistedFieldId) {
          const record = await this.fieldsService.findFieldRecordForUser(userId, persistedFieldId);
          resolvedFieldName = record?.name;
          fieldSource = 'conversation';
        }
        fieldMismatch = requestedFieldId !== null && requestedFieldId !== persistedFieldId;
      } else if (isGuest) {
        const builtIn = await this.fieldsService.findActiveBuiltInByName(payload.fieldName);
        if (builtIn) {
          fieldId = builtIn.id;
          resolvedFieldName = builtIn.name;
          fieldSource = 'requested';
        }
      } else {
        const authorized = await this.fieldsService.resolveAuthorizedField(userId, requestedFieldId);
        if (authorized) {
          fieldId = authorized.id;
          resolvedFieldName = authorized.name;
          fieldSource = 'requested';
        } else {
          // Absent, stale, malformed or someone else's: same outcome for all of them.
          fieldFallback = requestedFieldId !== null;
          const primary = await this.fieldsService.getUserPrimaryField(userId);
          if (primary) {
            fieldId = primary.field_id ?? primary.custom_field_id ?? null;
            resolvedFieldName = primary.name;
            fieldSource = fieldId ? 'primary' : 'none';
          }
        }
      }

      const mode: RealtimeMode = payload.mode ?? 'single';
      const isDualSpeaker = mode === 'dual_speaker';
      const isMultiSpeaker = mode === 'multiple_speaker';
      const shouldDiarize = isDualSpeaker || isMultiSpeaker;
      const audioFormat = this.normalizeAudioFormatHint(payload.audioFormat);

      // ── Entitlement checks (authenticated users only — guests use the
      // existing 5-prompt trial, checked above) ────────────────────────────
      // Checked once at session start, not mid-call, so a user is never cut
      // off mid-sentence — consistent with the ledger's fair-use framing.
      let tier: PlanType | undefined;
      let entitlements: PlanEntitlements | undefined;

      if (!isGuest) {
        ({ tier, entitlements } = await this.entitlementsService.getUserEntitlements(userId));

        if (!entitlements.allowedVoiceModes.includes(mode)) {
          // Checked here, before the Deepgram connect below, so a blocked
          // user gets this immediately instead of the mic UI sitting open
          // waiting on a "ready" event that will never arrive.
          this.emitEntitlementBlocked(
            client,
            'mode_not_permitted',
            'Upgrade your account to use this feature.',
            { mode, tier },
          );
          return;
        }

        if (entitlements.maxVoiceMinutesPerMonth !== null) {
          const voiceStatus = await this.usageService.getStatus(
            userId,
            'voice_seconds',
            entitlements.maxVoiceMinutesPerMonth * 60,
          );
          if (!voiceStatus.canUse) {
            this.emitEntitlementBlocked(
              client,
              'voice_minutes_exhausted',
              `You've used all ${entitlements.maxVoiceMinutesPerMonth} voice minutes included in your plan this month. Upgrade for more.`,
              { usedMinutes: Math.round(voiceStatus.used / 60), limitMinutes: entitlements.maxVoiceMinutesPerMonth },
            );
            return;
          }
        }
      }

      if (!conversationId) {
        const dbMode: ConversationMode = mode === 'multiple_speaker' ? 'multiple_speaker' : (mode as ConversationMode);

        // Reuse the most recent empty conversation for this user+mode rather than
        // creating a new one — prevents accumulation of duplicate "Untitled conversation"
        // rows when the user starts and stops recording without sending any messages.
        const emptyConv = !isGuest
          ? await this.conversationService.findRecentEmptyConversation(userId, dbMode, fieldId)
          : null;

        if (emptyConv) {
          conversationId = emptyConv.id;
          this.logger.log(`session:start: reusing empty conversation ${conversationId}`);
        } else {
          const conv = await this.conversationService.createConversation(
            userId,
            dbMode,
            fieldId ?? undefined,
          );
          conversationId = conv.id;
        }
      }

      // ── Resolve speaker roster (multi-speaker) + open Deepgram live session ──
      // Run concurrently — resolveSpeakerRoster is a DB round-trip independent
      // of providerConnectOptions, and serializing it in front of the Deepgram
      // connect pushed multi-speaker's session:start past the frontend's
      // "ready" timeout (the only mode that does this extra lookup).
      const providerConnectOptions = {
        diarize: shouldDiarize,
        utteranceEndMs: shouldDiarize ? 2000 : 1500,
        meetingMode: shouldDiarize,
        audioFormat,
      };
      const [speakerRoster, deepgramSession] = await Promise.all([
        (!isGuest && isMultiSpeaker)
          ? this.resolveSpeakerRoster(userId, payload.speakerRoster)
          : Promise.resolve([]),
        this.deepgramService.createLiveSession(client.id, providerConnectOptions),
      ]);
      const { emitter, sendAudio, sendFinalize, close } = deepgramSession;
      const speakerRosterByVoiceId = new Map<string, SpeakerRosterEntry>(
        speakerRoster
          .filter((e) => e.voiceSpeakerId)
          .map((e) => [e.voiceSpeakerId!, e]),
      );

      // Client resumed this conversation after a drop — the deferred
      // disconnect summary no longer applies; the real end will summarise.
      this.cancelPendingDisconnectSummary(conversationId);

      const session: ActiveSession = {
        userId,
        conversationId,
        fieldName: resolvedFieldName,
        fieldId,
        isGuest,
        startedAt: Date.now(),
        tier,
        entitlements,
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
        pendingUnattributedText: '',
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
        inFlightTurns: new Set<Promise<unknown>>(),
        acceptedTurnSeq: 0,
        settledTurnSeq: 0,
        metrics: createSessionMetrics(),
        traceId: randomUUID(),
        lastAckedSequence: null,
        lastAckedStreamId: null,
        providerEpoch: 0,
        currentRecoveryId: null,
        recoveryAttempt: 0,
        providerConnectOptions,
        recoveryAudioBuffer: [],
        recoveryAudioBufferBytes: 0,
        recoveryBufferOverflowStartedAt: null,
        recoveryDroppedBytes: 0,
      };

      this.attachDeepgramListeners(client, session, emitter);

      this.sessions.set(client.id, session);

      // ── Restore durable participants from previous sessions ───────────────
      // Load persisted participants for this conversation so the frontend can
      // restore identity state (names, roles) that survived a reconnect/refresh.
      let restoredParticipants: ConversationParticipant[] = [];
      if (!isGuest) {
        restoredParticipants = await this.conversationService
          .getConversationParticipants(conversationId, userId)
          .catch((err) => {
            this.logger.warn(`[${client.id}] Failed to load conversation participants: ${describeError(err)}`);
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
          this.logger.warn(`[${client.id}] Failed to upsert owner participant: ${describeError(err)}`),
        );

        // Pre-populate resolvedSpeakers from prior voice-ID confirmations so
        // returning participants are recognised without re-running identification.
        for (const p of restoredParticipants) {
          if (p.voice_confirmed && p.voice_speaker_id) {
            // We can't map to a Deepgram speaker ID yet (provider hasn't assigned
            // clusters), but we pre-load the roster so identifyMultiSpeaker()
            // can match quickly.  The actual mapping happens in identifyMultiSpeaker.
            this.logger.debug(`[${client.id}] Restored a voice-confirmed participant for conv ${conversationId}`);
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
            this.logger.warn(`[${client.id}] Failed to upsert roster participant: ${describeError(err)}`),
          );
        }
      }

      const rosterCount = speakerRoster.length;
      this.logLifecycle(session, 'session_start', { mode, isGuest });
      this.logger.log(
        `Session started — ${isGuest ? 'guest' : 'auth'}, trace: ${session.traceId}, ` +
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
        traceId: session.traceId,
        // Field this conversation lives under. `mismatch`: the client asked for a different
        // field than a resumed conversation's own (start a new conversation to change field);
        // `fallback`: the requested field ID was not usable, so the primary field applies.
        field: {
          id: fieldId,
          name: resolvedFieldName ?? null,
          source: fieldSource,
          mismatch: fieldMismatch,
          fallback: fieldFallback,
        },
        // Capability negotiation: clients only send session:timing:* when this is present.
        capabilities: { recordingTiming: this.recordingTimingService && !isGuest ? 1 : 0 },
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

  // ─── session:timing:* ───────────────────────────────────────────────────────
  // Durable per-logical-session capture timing. Clients send `start` only after
  // fresh microphone capture succeeded; reconnects reuse the same sessionId.
  // `report` carries cumulative captured intervals (offsets in ms from session
  // start) with a monotonic `seq`; `final: true` closes the session as complete.
  // Billing/usage metering is unaffected.
  private static readonly TIMING_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

  /**
   * Timing operations for one socket run strictly in arrival order. Socket.IO dispatches
   * events without waiting for earlier async handlers, so a final report sent right after
   * a start (or a session:end right after a report) could otherwise race an uncommitted
   * write and vanish. Each operation's outcome is also ACKNOWLEDGED to the client, so it can
   * retry or know the session's state instead of guessing.
   */
  private enqueueTiming<T>(session: ActiveSession, work: () => Promise<T>): Promise<T | undefined> {
    const run = (session.timingChain ?? Promise.resolve()).then(work, work);
    session.timingChain = run.catch(() => undefined);
    return run.catch((err) => {
      this.logger.error(`session timing operation failed (trace=${session.traceId}): ${describeError(err)}`);
      return undefined;
    });
  }

  @SubscribeMessage('session:timing:start')
  async handleTimingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId?: string },
  ): Promise<void> {
    const session = this.sessions.get(client.id);
    const sessionId = payload?.sessionId;
    if (!session || session.isGuest || !this.recordingTimingService) return;
    if (typeof sessionId !== 'string' || !VoiceGateway.TIMING_ID_PATTERN.test(sessionId)) {
      client.emit('session:timing:ack', { kind: 'start', applied: false, reason: 'invalid_session_id' });
      return;
    }
    await this.enqueueTiming(session, async () => {
      const res = await this.recordingTimingService!.startSession({
        userId: session.userId,
        conversationId: session.conversationId,
        clientSessionId: sessionId,
        socketId: client.id,
      });
      if (res) session.timingSessionId = sessionId;
      client.emit('session:timing:ack', res
        ? { kind: 'start', sessionId, applied: true, created: res.created, status: res.status }
        : { kind: 'start', sessionId, applied: false, reason: 'not_found' });
    });
  }

  @SubscribeMessage('session:timing:report')
  async handleTimingReport(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId?: string; seq?: number; intervals?: unknown; final?: boolean },
  ): Promise<void> {
    const session = this.sessions.get(client.id);
    if (!session || session.isGuest || !this.recordingTimingService) return;
    const sessionId = payload?.sessionId;
    if (typeof sessionId !== 'string' || !VoiceGateway.TIMING_ID_PATTERN.test(sessionId)) {
      client.emit('session:timing:ack', { kind: 'report', applied: false, reason: 'invalid_session_id' });
      return;
    }
    const seq = Number(payload.seq);
    await this.enqueueTiming(session, async () => {
      const result = await this.recordingTimingService!.applyReport({
        userId: session.userId,
        conversationId: session.conversationId,
        clientSessionId: sessionId,
        report: { seq, intervals: payload.intervals, final: payload.final === true },
      });
      client.emit('session:timing:ack', { kind: 'report', sessionId, seq: Number.isInteger(seq) ? seq : null, ...result });
    });
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

    this.logLifecycle(session, 'stream_start', { streamEpoch: payload.streamEpoch ?? 0 });
    client.emit('stream:ready', {
      traceId: session.traceId,
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
    // `held` = the server has taken responsibility for this chunk (sent to the
    // provider, or buffered for replay after recovery). Only held chunks are
    // acknowledged, so the client never frees audio that was silently lost.
    let held = true;
    const bufferMeta = { streamId: payload.recordingId ?? '__legacy__', sequence: payload.sequence ?? undefined };
    const admit = () => {
      const outcome = this.bufferAudioForRecovery(session, buffer, bufferMeta);
      const lost = [...outcome.evicted];
      if (!outcome.retained) lost.push({ streamId: bufferMeta.streamId, sequence: payload.sequence ?? null, bytes: buffer.length });
      this.recordRecoveryLoss(client, session, lost);
    };
    if (session.providerState === 'recovering') {
      admit();
    } else {
      const accepted = session.sendAudio(buffer) !== false;
      if (!accepted) {
        // Re-read: sendAudio's own failure signal may already have started recovery.
        const stateNow = session.providerState as ProviderSessionState;
        if (stateNow === 'active') {
          // Provider socket isn't usable: keep this chunk for replay and start recovery.
          admit();
          this.handleProviderDisruption(client, session, session.providerEpoch, 'transport_failure');
        } else if (stateNow === 'recovering') {
          // sendAudio's own failure signal already started recovery.
          admit();
        } else {
          held = false;
        }
      }
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
        this.logLifecycle(session, 'sequence_gap', { expected: lastSeq + 1, actual: payload.sequence, gaps: session.audioGapCount });
        client.emit('audio:continuity_warning', {
          reason: 'sequence_gap' satisfies AudioLossReason,
          correlation: this.correlation(session),
          streamId,
          expected: lastSeq + 1,
          actual: payload.sequence,
          recoverable: true,
          message: 'Some audio may be missing. Recording continues.',
        });
      }

      session.streamSequences.set(streamId, payload.sequence);
      if (!session.activeStreamId) session.activeStreamId = streamId;

      if (held) {
        session.lastAckedSequence = payload.sequence;
        session.lastAckedStreamId = streamId;
        client.emit('audio:ack', {
          sequence: payload.sequence,
          streamId,
          clientSessionId: session.clientSessionId,
        });
      }
    }

    // ── Per-speaker audio tagging ─────────────────────────────────────────
    const shouldDiarize = session.isDualSpeaker || session.isMultiSpeaker;
    if (shouldDiarize && !session.isGuest && this.voiceVerificationService.isEnabled) {
      const spk = session.currentDominantSpeaker;
      const spkBufs = session.speakerAudioBuffers.get(spk) ?? [];
      const spkBytes = session.speakerAudioBytes.get(spk) ?? 0;
      if (spkBytes >= this.AUDIO_BUFFER_CAP) this.noteBoundHit(session, 'speakerAudioCap');
      if (spkBytes < this.AUDIO_BUFFER_CAP) {
        spkBufs.push(buffer);
        session.speakerAudioBuffers.set(spk, spkBufs);
        session.speakerAudioBytes.set(spk, spkBytes + buffer.length);
      }
    }

    // ── General audio buffering ───────────────────────────────────────────
    const shouldBuffer = !session.isGuest && session.audioBufferBytes < this.AUDIO_BUFFER_CAP;
    this.maybeSampleSessionMetrics(session);
    const needsBuffer =
      shouldDiarize ||
      (!session.isDualSpeaker && !session.isMultiSpeaker && !session.singleSpeakerProfileTriggered && this.voiceVerificationService.isEnabled);

    if (!shouldBuffer && needsBuffer && !session.isGuest) this.noteBoundHit(session, 'audioBufferCap');
    if (shouldBuffer && needsBuffer) {
      session.audioBuffer.push(buffer);
      session.audioBufferBytes += buffer.length;
    }

    // ── Reset idle timeout ────────────────────────────────────────────────
    if (session.idleTimeoutHandle) clearTimeout(session.idleTimeoutHandle);
    session.idleTimeoutHandle = setTimeout(() => {
      this.logger.warn(`[${client.id}] Session idle for 30 min — auto-closing`);
      this.logLifecycle(session, 'session_terminal', { reason: 'idle_timeout' satisfies SessionTerminalReason });
      const correlation = this.correlation(session);
      this.cleanupSession(client.id);
      client.emit('session:ended', { reason: 'idle_timeout' satisfies SessionTerminalReason, correlation });
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
        if (session.sendFinalize() === false) {
          // The provider socket is not open: no Finalize will ever be acknowledged, so
          // don't sit out the whole drain timeout waiting for it.
          this.logger.warn(`Finalize not delivered (provider socket not open) trace=${session.traceId}`);
          cleanup();
        }
      } catch (err) {
        this.logger.warn(`sendFinalize threw: ${describeError(err)}`);
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
      // Wait for the turn that is running, then process the final turns queued behind
      // it — an 'already_processing' result must never be taken as completion.
      await this.drainSessionTurns(client, session, 'audio_stop');
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
    if (session.isDualSpeaker) {
      // The same words are also in the dual-speaker pending buffers; this path takes
      // them as one turn, so clear them or the session-end flush would save them twice.
      session.pendingOtherText = '';
      session.pendingOwnerText = '';
      session.pendingUnattributedText = '';
    }

    this.logger.log(`[${client.id}] audio:stop streamId=${streamId} drainMs=${drainMs} transcriptEmpty=${!transcript}`);
    client.emit('audio:finalized', { recordingId: streamId, transcriptDetected: Boolean(transcript) });

    if (!transcript) {
      client.emit('ai:skipped', { reason: 'empty_transcript' });
      return;
    }

    if (session.isProcessingAI) {
      // The final words are already taken out of the buffers above, so dropping them
      // here would lose them. Wait for the running turn (bounded) and then process
      // them; only a turn that really never finishes yields a truthful skip.
      const settled = await this.awaitInFlightTurns(session);
      if (!settled || session.isProcessingAI) {
        client.emit('ai:skipped', { reason: 'already_processing', transcript });
        return;
      }
    }

    const avgConfidence =
      confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : 1.0;

    const quality = this.isTranscriptMeaningful(transcript, avgConfidence);
    if (!quality.pass) {
      this.logger.log(`Transcript filtered [${quality.reason}]: words=${countWords(transcript)} (conf=${avgConfidence.toFixed(2)})`);
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
    } else if (!(await this.checkMessageQuota(client, session))) {
      return;
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
    } else if (!(await this.checkMessageQuota(client, session))) {
      return;
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

    session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => this.flipDualTurn(turn));

    this.conversationService.relabelSpeakers(session.conversationId, session.userId).catch((err) =>
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

    this.logger.log(`[${client.id}] Speaker named: role=${payload.speaker}`);

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

      session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn): DualSpeakerTurn => {
        if (turn.speaker === 'unknown') return turn; // never re-attributed by an owner correction
        const deepgramId = turn.speaker === 'owner'
          ? (confirmedOwnerSpeakerId === 0 ? 0 : 1)
          : (confirmedOwnerSpeakerId === 0 ? 1 : 0);
        return {
          ...turn,
          speaker: deepgramId === confirmedOwnerSpeakerId ? 'owner' : 'other',
        };
      });

      this.logger.log(
        `[${client.id}] Voice ID calibration — verified=${result.verified}, ownerSpeakerId=${confirmedOwnerSpeakerId}`,
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
      /** Provider epoch the speaker number was shown under (defaults to the current one). */
      providerEpoch?: number;
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

    const correctionEpoch = this.resolveCorrectionEpoch(session, payload.providerEpoch);
    try {
      await this.conversationService.correctTranscriptSpeaker({
        conversationId: session.conversationId,
        userId: session.userId,
        deepgramSpeakerId: payload.deepgramSpeakerId,
        segmentId: payload.segmentId,
        speakerId: speaker.id,
        speakerLabel: speaker.name,
        applyTo: payload.applyTo ?? 'session_speaker',
        recordingSessionId: session.recordingSessionId,
        providerEpoch: correctionEpoch,
      });
    } catch (err) {
      this.logger.warn(`[${client.id}] correctTranscriptSpeaker DB error: ${describeError(err)}`);
      this.emitError(client, 'SPEAKER_CORRECTION_FAILED', (err as Error).message, {
        clientMessage: 'Could not save the speaker correction. Please try again.',
        severity: 'warn',
      });
      return;
    }

    // Update in-memory state only after DB confirms — and only for the current
    // provider connection: an older epoch's speaker number must not label the
    // current connection's speaker with the same number.
    if (payload.deepgramSpeakerId != null && correctionEpoch === session.providerEpoch) {
      session.resolvedSpeakers.set(payload.deepgramSpeakerId, {
        speakerId: speaker.id,
        label: speaker.name,
        voiceSpeakerId: speaker.voice_speaker_id,
        method: 'manual',
        confidence: 1,
      });
    }

    this.logger.log(
      `[${client.id}] Speaker corrected: deepgramId=${payload.deepgramSpeakerId}, applyTo=${payload.applyTo ?? 'session_speaker'}`,
    );

    client.emit('transcript:speaker_corrected', {
      ...this.speakerScope(session, correctionEpoch),
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
      providerEpoch?: number;
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

    const renameEpoch = this.resolveCorrectionEpoch(session, payload.providerEpoch);
    try {
      const applyTo = payload.applyTo ?? 'session_speaker';
      await this.conversationService.renameAnonymousSpeaker({
        conversationId: session.conversationId,
        userId: session.userId,
        deepgramSpeakerId: payload.deepgramSpeakerId,
        speakerLabel: name,
        applyTo,
        recordingSessionId: session.recordingSessionId,
        providerEpoch: renameEpoch,
      });
    } catch (err) {
      this.logger.warn(`[${client.id}] renameAnonymousSpeaker DB error: ${describeError(err)}`);
      this.emitError(client, 'GUEST_RENAME_FAILED', (err as Error).message, {
        clientMessage: 'Could not save the guest name. Please try again.',
        severity: 'warn',
      });
      return;
    }

    // Update in-memory state only after DB confirms (current provider connection only)
    if (renameEpoch === session.providerEpoch) {
      session.resolvedSpeakers.set(payload.deepgramSpeakerId, {
        speakerId: null,
        label: name,
        voiceSpeakerId: null,
        method: 'manual',
        confidence: 1,
      });
      session.anonymousSpeakerLabels.set(payload.deepgramSpeakerId, name);
    }

    this.logger.log(`[${client.id}] Guest renamed: deepgramId=${payload.deepgramSpeakerId}`);

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
        this.logger.warn(`[${client.id}] Failed to persist renamed participant: ${describeError(err)}`),
      );
    }

    client.emit('transcript:speaker_corrected', {
      ...this.speakerScope(session, renameEpoch),
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

    // Stop ordering: wait for the turn that is running, process the final text
    // queued behind it, and wait for that too — all before cleanupSession clears the
    // buffers and before the summary reads history. `complete:false` means persistence
    // was not confirmed within the bound.
    const drain = session ? await this.drainSessionTurns(client, session, 'session_end') : { complete: true };

    if (session && !session.isGuest) {
      if (this.recordingTimingService) {
        void this.enqueueTiming(session, () => this.recordingTimingService!.closeBySocket({
          conversationId: session.conversationId,
          socketId: client.id,
          status: 'ended',
        }));
      }
      this.cancelPendingDisconnectSummary(session.conversationId);
      // Fire-and-forget: the client disconnects its socket immediately after
      // emitting session:end (doesn't wait for any ack), so this routinely
      // finishes after the live connection is already gone — delivery is via
      // the conversation's document list + push notification, same as any
      // document generated mid-conversation after the user has moved on.
      this.finalizeSessionOnExit(client, session, { drainComplete: drain.complete }).catch((err) =>
        this.logger.error(`Auto-summary failed for conversation ${session.conversationId}:`, err),
      );
    }

    if (session) this.logLifecycle(session, 'session_terminal', { reason: 'explicit_end' satisfies SessionTerminalReason, drainComplete: drain.complete });
    const endCorrelation = session ? this.correlation(session) : null;
    this.cleanupSession(client.id);
    client.emit(
      'session:ended',
      session ? { reason: 'explicit_end' satisfies SessionTerminalReason, drainComplete: drain.complete, correlation: endCorrelation } : undefined,
    );
  }

  /**
   * Shared non-blocking tail of a session's lifecycle: persists AI memory
   * and generates the auto-summary document. Called from both an explicit
   * session:end and a raw socket disconnect (see handleDisconnect) so a
   * "stop" that never emits session:end — app killed, network drop, a
   * client that just closes the socket instead of signalling first — still
   * gets the same auto-summary treatment. Does NOT include the
   * multi-speaker flush: that must be awaited by the caller before
   * cleanupSession clears the buffers it depends on, so it can't live here.
   */
  /**
   * Hands the dual-speaker pending text (owner / other / unattributed) to one AI
   * turn once it reaches `minWords`. Returns true if a turn was started. The text
   * is claimed synchronously after the quota await so concurrent callers can't both take it.
   */
  private async flushDualSpeakerPending(client: Socket, session: ActiveSession, minWords: number): Promise<boolean> {
    if (session.calibrationPhase) return false;

    const wordsIn = () =>
      `${session.pendingOwnerText} ${session.pendingOtherText} ${session.pendingUnattributedText}`
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
    if (wordsIn() < minWords) return false;
    if (!(await this.checkMessageQuota(client, session))) return false;

    if (session.isProcessingAI || wordsIn() < minWords) return false;
    const otherText = session.pendingOtherText.trim();
    const ownerText = session.pendingOwnerText.trim();
    const unattributedText = session.pendingUnattributedText.trim();

    session.pendingOtherText = '';
    session.pendingOwnerText = '';
    session.pendingUnattributedText = '';
    session.accumulatedTranscript = '';
    client.emit('transcript:update', { transcript: '', isFinal: true, cleared: true });

    const primaryText = otherText || ownerText;
    const contextText = otherText ? ownerText : '';
    const speakerDetected = Boolean(otherText);

    await this.processDualSpeakerPrompt(client, session, primaryText, contextText, speakerDetected, unattributedText);
    return true;
  }

  // ── Lifecycle correlation and terminal reasons (redacted: ids and counters only) ──

  private correlation(session: ActiveSession): SessionCorrelation {
    return {
      traceId: session.traceId ?? null,
      recordingSessionId: session.recordingSessionId ?? null,
      clientSessionId: session.clientSessionId ?? null,
      streamId: session.activeStreamId ?? null,
      providerEpoch: session.providerEpoch ?? null,
      lastAckedSequence: session.lastAckedSequence ?? null,
    };
  }

  /** One structured lifecycle line: event name + correlation ids + optional code/counters. Never content. */
  private logLifecycle(session: ActiveSession, event: string, extra: Record<string, string | number | boolean | null> = {}): void {
    const c = this.correlation(session);
    const kv = Object.entries({ ...c, ...extra })
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    this.logger.log(`lifecycle event=${event} ${kv}`);
  }

  // ── Bounded in-memory state + observability ──────────────────────────────────

  /** Counts a bound being reached; logs the first hit of each kind per session (ids only, no content). */
  private noteBoundHit(session: ActiveSession, kind: BoundKind): void {
    const m = session.metrics;
    if (!m) return;
    m.boundHits[kind] += 1;
    if (!m.loggedKinds.has(kind)) {
      m.loggedKinds.add(kind);
      this.logger.warn(`Session bound reached: ${kind} (trace=${session.traceId}, recordingSession=${session.recordingSessionId}, epoch=${session.providerEpoch})`);
    }
  }

  private pendingTextChars(session: ActiveSession): number {
    let chars = (session.pendingOwnerText?.length ?? 0) + (session.pendingOtherText?.length ?? 0) + (session.pendingUnattributedText?.length ?? 0);
    for (const t of session.pendingMultiSpeakerTurns ?? []) chars += t.text.length;
    return chars;
  }

  /** Samples current sizes into the high-water marks. O(#speakers); throttled by callers on the audio path. */
  private sampleSessionMetrics(session: ActiveSession): void {
    const m = session.metrics;
    if (!m) return;
    let speakerAudioBytes = 0;
    for (const bytes of session.speakerAudioBytes?.values() ?? []) speakerAudioBytes += bytes;
    recordHighWater(m, {
      multiHistoryTurns: session.multiSpeakerHistory?.length ?? 0,
      dualHistoryTurns: session.dualSpeakerHistory?.length ?? 0,
      confidenceSamples: session.transcriptConfidences?.length ?? 0,
      pendingTurns: session.pendingMultiSpeakerTurns?.length ?? 0,
      pendingChars: this.pendingTextChars(session),
      audioBufferBytes: session.audioBufferBytes ?? 0,
      speakerAudioBytes,
      recoveryBufferBytes: session.recoveryAudioBufferBytes ?? 0,
      recoveryBufferChunks: session.recoveryAudioBuffer?.length ?? 0,
      inFlightTurns: session.inFlightTurns?.size ?? 0,
    });
    m.lastSampledAt = Date.now();
  }

  /** Throttled sample for the hot audio path. */
  private maybeSampleSessionMetrics(session: ActiveSession): void {
    const m = session.metrics;
    if (!m || Date.now() - m.lastSampledAt < SESSION_BOUNDS.SAMPLE_INTERVAL_MS) return;
    this.sampleSessionMetrics(session);
  }

  /**
   * Keeps long-session memory bounded without losing anything that matters:
   *  • history windows / confidence samples are in-memory CONTEXT only — the full
   *    transcript is persisted — so the oldest entries are trimmed;
   *  • un-persisted pending turns/text are NEVER dropped: at their bound a flush is
   *    forced instead (skipped only while a turn is already processing, which drains
   *    them afterwards).
   */
  private enforceSessionBounds(client: Socket, session: ActiveSession): void {
    const trim = <T>(arr: T[], max: number, kind: BoundKind) => {
      const over = arr.length - max;
      if (over > 0) {
        arr.splice(0, over);
        session.metrics.trimmedHistoryTurns += kind === 'confidenceTrim' ? 0 : over;
        this.noteBoundHit(session, kind);
      }
    };
    trim(session.multiSpeakerHistory, SESSION_BOUNDS.MAX_MULTI_HISTORY_TURNS, 'multiHistoryTrim');
    trim(session.dualSpeakerHistory, SESSION_BOUNDS.MAX_DUAL_HISTORY_TURNS, 'dualHistoryTrim');
    trim(session.transcriptConfidences, SESSION_BOUNDS.MAX_CONFIDENCE_SAMPLES, 'confidenceTrim');

    this.sampleSessionMetrics(session);

    const pendingTurns = session.pendingMultiSpeakerTurns.length;
    const pendingChars = this.pendingTextChars(session);
    const atBound = pendingTurns >= SESSION_BOUNDS.MAX_PENDING_TURNS || pendingChars >= SESSION_BOUNDS.MAX_PENDING_CHARS;
    if (atBound && !session.isProcessingAI) {
      this.noteBoundHit(session, 'pendingForceFlush');
      const flush = session.isMultiSpeaker
        ? this.flushMultiSpeakerTurns(client, session, { reason: 'utterance_end', minWords: 1 })
        : session.isDualSpeaker
          ? this.flushDualSpeakerPending(client, session, 1)
          : Promise.resolve(false);
      flush.catch((err) => this.logger.error(`[${client.id}] bound-forced flush failed:`, err));
    }
  }

  /** Registers an AI turn so Stop / the summary can wait for it. Removes itself when settled. */
  private trackTurn(session: ActiveSession, run: () => Promise<void>): Promise<void> {
    const promise = run();
    const set = session.inFlightTurns;
    if (!set) return promise;
    session.acceptedTurnSeq = (session.acceptedTurnSeq ?? 0) + 1;
    set.add(promise);
    const done = () => {
      set.delete(promise);
      session.settledTurnSeq = (session.settledTurnSeq ?? 0) + 1;
    };
    promise.then(done, done);
    return promise;
  }

  /**
   * Waits (bounded) for every AI turn still being processed. Resolves true when
   * all have settled, false if the bound was hit first — callers must treat
   * false as "persistence not confirmed", not as completion. Never throws.
   */
  private async awaitInFlightTurns(session: ActiveSession, timeoutMs = IN_FLIGHT_TURN_WAIT_MS): Promise<boolean> {
    const pending = session.inFlightTurns;
    if (!pending || pending.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.logger.warn(`Gave up waiting for ${pending.size} in-flight turn(s) after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled([...pending]).then(() => undefined), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return !timedOut && pending.size === 0;
  }

  /** Resolves 'done' with the promise's outcome, or 'timeout' if it has not settled within `ms`. */
  private async withDeadline(promise: Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.max(0, ms)); });
    try {
      return await Promise.race([promise.then(() => 'done' as const, () => 'done' as const), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Whether one more turn may be spent right now (guest prompt trial / plan quota). */
  private async canSpendTurn(client: Socket, session: ActiveSession): Promise<boolean> {
    if (session.isGuest && session.guestSessionId) {
      const gs = await this.guestSessionService.getStatus(session.guestSessionId);
      return gs.canSend;
    }
    return this.checkMessageQuota(client, session);
  }

  /**
   * Starts whatever final text this session still holds un-processed (multi-speaker
   * queue, dual-speaker pending text, single-speaker accumulated transcript) as a
   * tracked turn. Returns true if a turn was started. The queue/buffer is claimed
   * synchronously after the quota await, so two concurrent exits can't both take it.
   */
  private async flushPendingTurnsForExit(client: Socket, session: ActiveSession): Promise<boolean> {
    if (session.isMultiSpeaker) {
      return this.flushMultiSpeakerTurns(client, session, { reason: 'session_end', minWords: 1 });
    }
    if (session.isDualSpeaker) {
      return this.flushDualSpeakerPending(client, session, 1);
    }

    const transcript = (session.accumulatedTranscript ?? '').trim();
    if (!transcript) return false;
    if (!(await this.canSpendTurn(client, session))) return false;
    const claimed = (session.accumulatedTranscript ?? '').trim();
    if (!claimed || session.isProcessingAI) return false;
    session.accumulatedTranscript = '';
    session.transcriptConfidences = [];
    await this.processPrompt(client, session, claimed, 'voice');
    return true;
  }

  /**
   * The one barrier at every stop/end boundary (audio:stop, session:end, raw
   * disconnect). Loops: wait for the running turn → start whatever final text is
   * still queued behind it → wait again, until nothing new starts. `complete` is
   * true only when every turn accepted before the boundary has reached a terminal
   * state; false means the bound was hit and persistence is NOT confirmed.
   */
  private async drainSessionTurns(
    client: Socket,
    session: ActiveSession,
    reason: 'audio_stop' | 'session_end' | 'disconnect',
  ): Promise<{ complete: boolean; passes: number }> {
    const deadline = Date.now() + IN_FLIGHT_TURN_WAIT_MS;
    for (let pass = 1; pass <= MAX_DRAIN_PASSES; pass++) {
      if (!(await this.awaitInFlightTurns(session, Math.max(0, deadline - Date.now())))) {
        this.logger.warn(`[${client.id}] turn drain incomplete (${reason}) accepted=${session.acceptedTurnSeq} settled=${session.settledTurnSeq}`);
        return { complete: false, passes: pass };
      }
      const flush = this.flushPendingTurnsForExit(client, session).catch((err) => {
        this.logger.error(`[${client.id}] ${reason} flush failed:`, err);
        return false;
      });
      const outcome = await this.withDeadline(flush, deadline - Date.now());
      if (outcome === 'timeout') {
        this.logger.warn(`[${client.id}] turn drain timed out while flushing (${reason})`);
        return { complete: false, passes: pass };
      }
      if (!(await flush)) {
        return { complete: (session.inFlightTurns?.size ?? 0) === 0, passes: pass };
      }
    }
    return { complete: (session.inFlightTurns?.size ?? 0) === 0, passes: MAX_DRAIN_PASSES };
  }

  private async finalizeSessionOnExit(
    client: Socket,
    session: ActiveSession,
    opts: { drainComplete?: boolean } = {},
  ): Promise<void> {
    const settled = await this.awaitInFlightTurns(session);
    if (opts.drainComplete === false || !settled) {
      // A turn accepted before the stop was not confirmed persisted: a summary now
      // would claim complete context it doesn't have. Mark it retryable instead; the
      // next resume + stop re-claims (failed is claimable) and summarises everything.
      this.logger.warn(`Auto-summary withheld for ${session.conversationId}: final turns not confirmed persisted`);
      await this.conversationService
        .setSummaryStatus(session.conversationId, session.userId, 'failed', { skipReason: 'final_turns_incomplete' })
        .catch((err) => this.logger.error('Failed to mark summary incomplete:', err));
      return;
    }
    this.saveSessionMemory(session).catch((err) => this.logger.error('Memory save failed:', err));
    await this.autoGenerateConversationSummary(client, session);
  }

  /**
   * Generates a brief recap document (Summary / Key Insights / Follow-up
   * Actions / Suggested Questions) the moment a conversation ends, instead
   * of waiting for the user to ask for one via chat. Obeys the exact same
   * entitlement rules as an explicitly requested document — same monthly
   * cap, same depth restriction — so this convenience path can't be used to
   * bypass the document quota a tier is supposed to enforce; it only
   * applies to conversations with enough actual content to summarize.
   */
  /**
   * Conversations whose summary this process is generating right now, and the
   * conversations that were stopped again while that was running. A Stop that
   * lands on an in-flight generation can't claim (it's 'pending'), but its newer
   * turns are not in the in-flight summary's snapshot — so it asks for exactly one
   * follow-up run, executed when the in-flight one finishes, instead of being
   * silently dropped.
   */
  private readonly summariesInFlight = new Set<string>();
  private readonly summaryRerunRequests = new Map<string, { client: Socket; session: ActiveSession }>();

  private async autoGenerateConversationSummary(client: Socket, session: ActiveSession): Promise<void> {
    const id = session.conversationId;
    if (this.summariesInFlight.has(id)) {
      this.summaryRerunRequests.set(id, { client, session });
      this.logger.log(`Auto-summary for ${id} already running — queued one follow-up run for newer turns`);
      return;
    }

    this.summariesInFlight.add(id);
    try {
      await this.runAutoSummary(client, session);
    } finally {
      this.summariesInFlight.delete(id);
      const again = this.summaryRerunRequests.get(id);
      if (again) {
        this.summaryRerunRequests.delete(id);
        // Re-claims: succeeds only if something was said after the finished run's snapshot.
        await this.autoGenerateConversationSummary(again.client, again.session).catch((err) =>
          this.logger.error(`Follow-up auto-summary failed for conversation ${id}:`, err),
        );
      }
    }
  }

  private async runAutoSummary(client: Socket, session: ActiveSession): Promise<void> {
    // Set 'pending' immediately so a client polling GET /conversations/:id
    // right after session:end sees real state instead of 'not_started' while
    // the gates below are still being evaluated — the live socket events
    // further down frequently never arrive (client has usually already
    // disconnected by the time any of this resolves), so this persisted
    // status is the only delivery channel a client can actually rely on.
    // The claim also sets summary_status='pending'. It's atomic, so overlapping
    // triggers (drop + reconnect + stop) collapse into one summary and one email.
    const claimed = await this.conversationService
      .claimSummaryGeneration(session.conversationId, session.userId)
      .catch((err) => {
        this.logger.warn(`Failed to claim summary for ${session.conversationId}:`, err);
        return false;
      });
    if (!claimed) {
      this.logger.log(`Auto-summary skipped for ${session.conversationId}: already pending or up to date`);
      return;
    }

    const entitlements = session.entitlements;
    if (!entitlements || entitlements.maxDocumentsPerMonth <= 0 || entitlements.allowedDocumentDepths.length === 0) {
      // tier doesn't include document generation — this is a bonus, not an explicit request
      await this.conversationService.setSummaryStatus(session.conversationId, session.userId, 'skipped', { skipReason: 'tier_no_documents' });
      return;
    }

    // Only what was said since the last summarised part — a resumed
    // conversation gets a new part appended to the earlier ones instead of a
    // from-scratch re-summary of everything.
    const newMessages = await this.conversationService.getUnsummarizedMessages(session.conversationId, session.userId);
    // Complete context: nothing is dropped. Short conversations go to the model in one
    // call; longer ones are condensed in ordered chunks and summarised from all the notes;
    // past the hard bound the summary fails truthfully (see buildInsightSummary).
    const plan = planSummaryContext(newMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })));
    if (plan.kind === 'empty') {
      // Nothing new to summarise. If an earlier part exists, the conversation's
      // summary is still current — restore 'ready' rather than 'skipped'.
      const priorParts = await this.conversationService.getSummaryParts(session.conversationId, session.userId);
      if (priorParts.length > 0) {
        await this.conversationService.setSummaryStatus(session.conversationId, session.userId, 'ready');
      } else {
        await this.conversationService.setSummaryStatus(session.conversationId, session.userId, 'skipped', { skipReason: 'too_short' });
      }
      return; // nothing was said — genuinely nothing to summarize
    }
    // Deliberately no minimum word count beyond that: a short conversation
    // still gets a real summary, just a short, honest one — generateConversationSummaryDocument
    // writes "Summary" unconditionally and only includes Key Insights/Follow-up
    // Actions when the conversation actually earned them, so a brief exchange
    // correctly lands as a plain recap instead of being skipped outright.

    const docStatus = await this.usageService.getStatus(session.userId, 'documents', entitlements.maxDocumentsPerMonth);
    if (!docStatus.canUse) {
      await this.conversationService.setSummaryStatus(session.conversationId, session.userId, 'skipped', { skipReason: 'quota_exceeded' });
      return; // monthly document cap already hit
    }

    const transcript = this.buildVerbatimTranscript(newMessages, session);

    const built = await this.buildInsightSummary(session, plan);
    if (!built.ok) {
      // Truthful failure: no summary is written (or recorded as covering anything), the stored
      // messages are untouched, and the next resume + stop re-claims (failed is claimable).
      await this.conversationService.setSummaryStatus(session.conversationId, session.userId, 'failed', { skipReason: built.reason });
      client.emit('document:failed', { title: 'Conversation summary', reason: SUMMARY_FAILURE_MESSAGES[built.reason], reasonCode: built.reason, auto: true });
      return;
    }
    const summary = built.summary;

    // Code-built from the stored transcript, not model output — guarantees
    // the "word for word, who said what" section can't be paraphrased or
    // hallucinated by the model. Spliced in right after Summary, Teams-style.
    if (transcript) {
      summary.sections.splice(1, 0, { heading: 'Transcript', content: transcript });
    }
    // "Action Points / Next Steps" always last, whatever the model named the
    // equivalent section (it's asked for "Follow-up Actions").
    const actionIdx = summary.sections.findIndex((s) => /follow-?up actions?/i.test(s.heading));
    if (actionIdx !== -1) {
      const [actionSection] = summary.sections.splice(actionIdx, 1);
      summary.sections.push({ ...actionSection, heading: 'Action Points / Next Steps' });
    }

    let combined: { title: string; topic: string; sections: Array<{ heading: string; content: string }> };
    try {
      const priorParts = await this.conversationService.getSummaryParts(session.conversationId, session.userId);
      const conversationTitle = await this.conversationService.getConversationTitle(session.conversationId, session.userId);
      combined = buildCombinedSummary(
        [
          ...priorParts,
          { title: summary.title, topic: summary.topic, sections: summary.sections, covers_from: new Date(newMessages[0].created_at) },
        ],
        conversationTitle,
      );
    } catch (err) {
      await this.conversationService.setSummaryStatus(session.conversationId, session.userId, 'failed', { skipReason: 'generation_error' });
      throw err;
    }

    client.emit('document:generating', { title: combined.title, topic: combined.topic, auto: true });

    try {
      const result = await this.documentService.generateAndUpload({
        userId: session.userId,
        conversationId: session.conversationId,
        title: combined.title,
        topic: combined.topic,
        sections: combined.sections,
        depth: 'brief',
        format: 'docx',
        allowedDepths: entitlements.allowedDocumentDepths,
        skipSectionLimit: true,
      });

      // Recorded only after the document exists, so a failed upload leaves
      // this stretch unsummarised for the next attempt instead of "covered".
      await this.conversationService.addSummaryPart(session.conversationId, session.userId,
        { title: summary.title, topic: summary.topic, sections: summary.sections },
        newMessages[0].id,
        newMessages[newMessages.length - 1].id,
      );

      await this.usageService.tryConsume(session.userId, 'documents', 1, entitlements.maxDocumentsPerMonth);
      await this.conversationService.setSummaryStatus(session.conversationId, session.userId, 'ready', { documentId: result.docId });

      // Persisted, not just live-emitted — the manual "generate a document"
      // chat flow already does this (see processPrompt's onDone), and this
      // path was the one gap: without a real conversation_messages row
      // carrying document_id, the document:ready event was the ONLY place
      // this ever appeared. A client that wasn't connected at that exact
      // moment, or that simply reopens the conversation later, had no way
      // to discover it again — the document itself was never lost (still in
      // generated_documents, still linked via conversations.summary_document_id),
      // just unreachable from the conversation history a user actually looks at.
      await this.conversationService.saveMessage({
        conversationId: session.conversationId,
        userId: session.userId,
        role: 'assistant',
        content: `${combined.title} is ready.`,
        documentId: result.docId,
      });

      client.emit('document:ready', {
        docId: result.docId,
        title: combined.title,
        topic: combined.topic,
        format: 'docx',
        downloadUrl: result.downloadUrl,
        auto: true,
      });

      this.pushNotificationService
        .sendToUser(session.userId, {
          title: 'Your conversation summary is ready',
          body: combined.title,
          data: { docId: result.docId, downloadUrl: result.downloadUrl },
        })
        .catch((err) => this.logger.warn(`Push notification failed for auto-summary ${result.docId}: ${describeError(err)}`));

      // Fire-and-forget, same as the push notification above: for a user
      // who's already closed the app, this is the one delivery channel that
      // doesn't depend on a live connection or a notification permission.
      this.sendSummaryReadyEmail(session, combined, result.docId).catch((err) =>
        this.logger.warn(`Summary-ready email failed for conversation ${session.conversationId}: ${describeError(err)}`),
      );

      this.logger.log(`Auto-summary generated for conversation ${session.conversationId} (doc ${result.docId})`);
    } catch (err) {
      await this.conversationService.setSummaryStatus(session.conversationId, session.userId, 'failed', { skipReason: 'generation_error' });
      client.emit('document:failed', { title: combined.title, reason: "We couldn't generate your conversation summary.", auto: true });
      throw err;
    }
  }

  /**
   * Turns the planned context into the structured summary using bounded model work:
   * every step has a timeout, the whole job has a total budget, and any step that fails
   * fails the whole summary — it never writes one that skips a part of the conversation.
   * Logs counts only (no content).
   */
  private async buildInsightSummary(
    session: ActiveSession,
    plan: ContextPlan,
  ): Promise<
    | { ok: true; summary: { title: string; topic: string; sections: Array<{ heading: string; content: string }> }; coverage: ContextCoverage }
    | { ok: false; reason: SummaryFailureReason }
  > {
    const startedAt = Date.now();
    const finish = (outcome: string, extra: Record<string, number> = {}) =>
      this.logLifecycle(session, 'summary_context', {
        outcome,
        kind: plan.kind,
        messages: plan.coverage.messageCount,
        chars: plan.coverage.charCount,
        chunks: plan.coverage.chunkCount,
        elapsedMs: Date.now() - startedAt,
        ...extra,
      });

    if (plan.kind === 'too_large') {
      finish('context_too_large', { maxChars: plan.maxChars });
      return { ok: false, reason: 'context_too_large' };
    }
    if (plan.kind === 'empty') return { ok: false, reason: 'generation_error' };

    const step = async <T>(fn: () => Promise<T | null>): Promise<T | 'timeout' | null> => {
      const remaining = SUMMARY_CONTEXT_BOUNDS.TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) return 'timeout';
      try {
        const r = await raceDeadline(fn(), Math.min(SUMMARY_CONTEXT_BOUNDS.STEP_TIMEOUT_MS, remaining));
        return r.timedOut ? 'timeout' : r.value;
      } catch {
        return null;
      }
    };
    const fail = (reason: SummaryFailureReason) => {
      finish(reason);
      return { ok: false as const, reason };
    };

    let summary: { title: string; topic: string; sections: Array<{ heading: string; content: string }> } | 'timeout' | null;
    if (plan.kind === 'single') {
      summary = await step(() => this.claudeService.generateConversationSummaryDocument(plan.turns, session.fieldName));
    } else {
      const notes: string[] = [];
      for (const chunk of plan.chunks) {
        const result = await step(() =>
          this.claudeService.summarizeConversationChunk(
            chunk.turns,
            { index: chunk.index, total: plan.chunks.length },
            session.fieldName,
            SUMMARY_CONTEXT_BOUNDS.NOTES_MAX_CHARS,
          ),
        );
        if (result === 'timeout') return fail('generation_timeout');
        if (!result) return fail('generation_error');
        notes.push(result);
      }
      summary = await step(() => this.claudeService.generateConversationSummaryFromNotes(notes, session.fieldName));
    }

    if (summary === 'timeout') return fail('generation_timeout');
    if (!summary) return fail('generation_error');
    finish('ok');
    return { ok: true, summary, coverage: plan.coverage };
  }

  /**
   * PDF attachment, not the stored .docx — see EmailService.sendConversationSummaryEmail
   * for why. Generated fresh from the same sections already used for the
   * stored document, not derived from it, so no extra upload/round-trip is
   * needed just to get bytes to attach.
   */
  private async sendSummaryReadyEmail(
    session: ActiveSession,
    summary: { title: string; sections: Array<{ heading: string; content: string }> },
    documentId: string,
  ): Promise<void> {
    if (session.isGuest) return;

    // Records the coarse outcome only (status + reason code). A failure to record it must
    // never affect the email or the summary's readiness, so it is swallowed (and logged coarsely).
    const record = async (status: 'pending' | 'accepted_by_provider' | 'failed' | 'skipped', reason: SummaryEmailReason | null = null) => {
      try {
        await this.conversationService.setSummaryEmailStatus(session.conversationId, session.userId, { status, reason, documentId });
      } catch (err) {
        this.logger.warn(`Could not record summary email outcome (trace=${session.traceId}): ${describeError(err)}`);
      }
    };

    let email: string | undefined;
    try {
      email = (await this.usersService.findById(session.userId))?.email ?? undefined;
    } catch (err) {
      await record('failed', 'unknown_error');
      throw err;
    }
    if (!email) {
      await record('skipped', 'no_recipient');
      return;
    }

    await record('pending');
    let stage: 'attachment' | 'send' = 'attachment';
    try {
      const conversationTitle = (await this.conversationService.getConversationTitle(session.conversationId, session.userId)) ?? summary.title;
      const pdfBuffer = await this.documentService.buildSummaryPdfBuffer(summary.title, summary.sections);
      const filename = `${summary.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'conversation-summary'}.pdf`;

      stage = 'send';
      await this.emailService.sendConversationSummaryEmail(email, conversationTitle, {
        filename,
        content: pdfBuffer,
      });
      // Accepted by the provider for delivery — not confirmation it reached an inbox.
      await record('accepted_by_provider');
    } catch (err) {
      await record('failed', stage === 'attachment' ? 'attachment_failed' : classifyEmailError(err));
      throw err;
    }
  }

  /**
   * Word-for-word transcript with real speaker names, Teams-recap style —
   * built directly from the saved messages (never from a model) so it can't
   * drift from what was actually said. Resolves 'owner'/'other' against the
   * session's live display names; multi-speaker messages already carry real
   * names bracketed per line (see buildMultiSpeakerSegmentDtos) and are
   * reformatted to match the "Name: text" shape used throughout.
   */
  private buildVerbatimTranscript(messages: ConversationMessage[], session: ActiveSession): string {
    const lines: string[] = [];

    for (const m of messages) {
      if (m.role === 'assistant') {
        if (m.content?.trim()) lines.push(`CognIX AI: ${m.content.trim()}`);
        continue;
      }

      const text = (m.transcript ?? m.content ?? '').trim();
      if (!text) continue;

      if (m.speaker_label === 'multiple_speakers') {
        // Already "[Name]: text" per line — reformat to drop the brackets.
        for (const rawLine of text.split('\n')) {
          const match = rawLine.match(/^\[(.+?)\]:\s*(.*)$/);
          if (match) lines.push(`${match[1]}: ${match[2]}`);
          else if (rawLine.trim()) lines.push(rawLine.trim());
        }
        continue;
      }

      const speakerName =
        m.speaker_label === 'owner'
          ? session.cachedOwnerName
          : m.speaker_label === 'other'
            ? (session.otherSpeakerName ?? 'Other Speaker')
            : session.cachedOwnerName; // single-speaker/text mode — the one human in the conversation

      lines.push(`${speakerName}: ${text}`);
    }

    return lines.join('\n');
  }

  // ─── Multi-speaker prompt processing (Gap 4) ─────────────────────────────────

  private processMultiSpeakerPrompt(client: Socket, session: ActiveSession, turns: MultiSpeakerTurn[]): Promise<void> {
    return this.trackTurn(session, () => this.runMultiSpeakerPrompt(client, session, turns));
  }

  private async runMultiSpeakerPrompt(
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
      const outputLanguage = session.isGuest ? 'en' : await this.settingsService.getEffectiveLanguage(session.userId);
      const systemPrompt = this.claudeService.buildDualSpeakerPrompt(
        session.fieldName,
        session.cachedAiMemory ?? undefined,
        msDocContext,
        outputLanguage,
      );

      // Gap 8: persist the user message and segments BEFORE starting the AI stream
      // so they are never lost if the stream errors or the client disconnects.
      const userContent = turns.map((t) => `[${t.speakerLabel}]: ${t.text}`).join('\n');
      const rawTranscript = turns.map((t) => t.text).join(' ');

      const segments = this.buildMultiSpeakerSegmentDtos(session, turns);
      await this.conversationService.saveMessageWithTranscriptSegments(
        {
          conversationId: session.conversationId,
          userId: session.userId,
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
            userId: session.userId,
            role: 'assistant',
            content: fullText,
            tokensUsed: inputTokens + outputTokens,
            latencyMs: Date.now() - aiStartTime,
          });

          this.claudeService
            .generateConversationTitle(rawTranscript, fullText, session.fieldName, outputLanguage)
            .then(async (title) => {
              const wasSet = await this.conversationService.setTitle(session.conversationId, session.userId, title);
              if (wasSet) client.emit('conversation:titled', { conversationId: session.conversationId, title });
            })
            .catch((err) => this.logger.error('Multi-speaker title generation failed:', err));

          if (session.entitlements) {
            this.usageService
              .tryConsume(session.userId, 'messages', 1, session.entitlements.maxMessagesPerMonth)
              .catch((err) => this.logger.error(`Failed to record message usage (trace=${session.traceId}): ${describeError(err)}`));
          }

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

  private processDualSpeakerPrompt(
    client: Socket,
    session: ActiveSession,
    otherPersonText: string,
    ownerText: string = '',
    speakerDetected = true,
    unattributedText: string = '',
  ): Promise<void> {
    return this.trackTurn(session, () =>
      this.runDualSpeakerPrompt(client, session, otherPersonText, ownerText, speakerDetected, unattributedText),
    );
  }

  private async runDualSpeakerPrompt(
    client: Socket,
    session: ActiveSession,
    otherPersonText: string,
    ownerText: string = '',
    speakerDetected = true,
    unattributedText: string = '',
  ): Promise<void> {
    // The text the AI answers: the other person's words, else (nothing attributed
    // to anyone) the unattributed text.
    const primaryText = otherPersonText || unattributedText;
    session.isProcessingAI = true;
    const aiStartTime = Date.now();
    let aiStarted = false;

    const speakerName = session.otherSpeakerName ?? 'Guest Speaker';
    const ownerName = session.cachedOwnerName;

    try {
      const recentHistory = session.dualSpeakerHistory.slice(-40);
      const conversationContext = recentHistory
        .map((t) => `[${t.speaker === 'owner' ? ownerName : t.speaker === 'unknown' ? UNATTRIBUTED_SPEAKER_LABEL : speakerName}]: ${t.text}`)
        .join('\n');

      const userMessage = speakerDetected
        ? `Conversation so far:\n${conversationContext}\n\nOther person just said: "${otherPersonText}"\n\nGive the owner a brief insight.`
        : `Conversation so far:\n${conversationContext}\n\nMost recent exchange: "${primaryText}"\n\nGive the owner a brief insight based on the ongoing conversation.`;

      const dsDocContext = await this.conversationService.getFullDocumentContext(session.conversationId, session.userId).catch(() => null);
      const outputLanguage = session.isGuest ? 'en' : await this.settingsService.getEffectiveLanguage(session.userId);
      const systemPrompt = this.claudeService.buildDualSpeakerPrompt(
        session.fieldName,
        session.cachedAiMemory ?? undefined,
        dsDocContext,
        outputLanguage,
      );

      client.emit('transcript:confirmed', {
        transcript: primaryText,
        inputType: 'voice',
        speaker: speakerDetected ? 'other' : otherPersonText || ownerText ? 'owner' : 'unknown',
        ...(unattributedText ? { unattributed: { transcript: unattributedText } } : {}),
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
              userId: session.userId,
              role: 'user',
              content: ownerText,
              transcript: ownerText,
              speakerLabel: 'owner',
            });
          }
          if (otherPersonText) {
            await this.conversationService.saveMessage({
              conversationId: session.conversationId,
              userId: session.userId,
              role: 'user',
              content: otherPersonText,
              transcript: otherPersonText,
              // With no other speaker detected, otherPersonText is really the owner's own
              // words (the caller promotes them to the primary slot) — never label them 'other'.
              speakerLabel: speakerDetected ? 'other' : 'owner',
            });
          }
          if (unattributedText) {
            // Persisted as its own message with an explicit 'unknown' speaker so the
            // recognised words are never lost and never pinned on owner/other.
            await this.conversationService.saveMessage({
              conversationId: session.conversationId,
              userId: session.userId,
              role: 'user',
              content: unattributedText,
              transcript: unattributedText,
              speakerLabel: 'unknown',
            });
          }
          await this.conversationService.saveMessage({
            conversationId: session.conversationId,
            userId: session.userId,
            role: 'assistant',
            content: fullText,
            tokensUsed: inputTokens + outputTokens,
            latencyMs: Date.now() - aiStartTime,
          });

          this.claudeService
              .generateConversationTitle(primaryText, fullText, session.fieldName, outputLanguage)
            .then(async (title) => {
              const wasSet = await this.conversationService.setTitle(session.conversationId, session.userId, title);
              if (wasSet) client.emit('conversation:titled', { conversationId: session.conversationId, title });
            })
            .catch((err) => this.logger.error('Dual-speaker title generation failed:', err));

          if (session.entitlements) {
            this.usageService
              .tryConsume(session.userId, 'messages', 1, session.entitlements.maxMessagesPerMonth)
              .catch((err) => this.logger.error(`Failed to record message usage (trace=${session.traceId}): ${describeError(err)}`));
          }

          client.emit('ai:done', {
            response: fullText,
            tokensUsed: inputTokens + outputTokens,
            latencyMs: Date.now() - aiStartTime,
            dualSpeaker: {
              owner: { transcript: speakerDetected ? ownerText : ownerText || otherPersonText, name: ownerName },
              speaker: { transcript: speakerDetected ? otherPersonText : '', name: speakerName },
              ...(unattributedText ? { unattributed: { transcript: unattributedText } } : {}),
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
      const history = await this.conversationService.getRecentHistoryForAI(session.conversationId, session.userId,
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
      this.logger.log(`Memory saved (trace=${session.traceId})`);
    } catch (err) {
      this.logger.error('saveSessionMemory error:', err);
    }
  }

  // ─── Core single-speaker prompt processing ───────────────────────────────────

  private processPrompt(
    client: Socket,
    session: ActiveSession,
    userMessage: string,
    inputType: 'voice' | 'text',
  ): Promise<void> {
    return this.trackTurn(session, () => this.runPrompt(client, session, userMessage, inputType));
  }

  private async runPrompt(
    client: Socket,
    session: ActiveSession,
    userMessage: string,
    inputType: 'voice' | 'text',
  ): Promise<void> {
    session.isProcessingAI = true;
    const aiStartTime = Date.now();
    let aiStarted = false;

    try {
      const history = await this.conversationService.getRecentHistoryForAI(session.conversationId, session.userId, 40);

      if (inputType === 'voice' && history.length >= 4) {
        const relevant = await this.claudeService.checkTopicRelevance(userMessage, history, session.fieldName);
        if (!relevant) {
          this.logger.log(`Topic filter blocked a prompt (words=${countWords(userMessage)})`);
          client.emit('ai:skipped', { reason: 'off_topic', transcript: userMessage });
          session.isProcessingAI = false;
          return;
        }
      }

      await this.conversationService.saveMessage({
        conversationId: session.conversationId,
        userId: session.userId,
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
      // Document generation is registered as a real tool for every turn
      // whose tier currently has quota for it — NOT gated behind a single-
      // message keyword regex (see comment above on why). A zero-document
      // tier (Free) or an exhausted monthly cap disables the tool entirely.
      let documentGenerationEnabled = !session.isGuest;
      let documentUnavailableReason: string | undefined;
      let documentUsageLimit: number | null = null;

      if (documentGenerationEnabled && session.entitlements) {
        if (session.entitlements.maxDocumentsPerMonth <= 0) {
          documentGenerationEnabled = false;
          documentUnavailableReason = 'Upgrade your account to use this feature.';
        } else {
          documentUsageLimit = session.entitlements.maxDocumentsPerMonth;
          const docStatus = await this.usageService.getStatus(session.userId, 'documents', documentUsageLimit);
          if (!docStatus.canUse) {
            documentGenerationEnabled = false;
            documentUnavailableReason = `You've used all ${docStatus.limit} documents included in your plan this month. Upgrade for more.`;
          }
        }
      }

      // Soft hint used ONLY to decide whether this voice turn is worth the
      // latency of also registering web_search (voice search is off by
      // default for response speed) — never a gate on whether
      // generate_document itself is available.
      const documentIntentHint =
        /\b(?:prepar(?:e|es|ing)|creat(?:e|es|ing)|generat(?:e|es|ing)|writ(?:e|es|ing)|mak(?:e|es|ing)|draft(?:s|ing)?|put together)\b.{0,30}\b(document|report|file|proposal|paper|essay|article|doc|write-up)\b/i.test(userMessage);

      // Free tier's web search cap (10/mo) — paid tiers carry
      // maxWebSearchesPerMonth: null (unlimited/fair-use) and skip the check.
      let webSearchAllowed = true;
      let webSearchUsed = 0;
      let webSearchLimit: number | null = null;
      if (session.entitlements && session.entitlements.maxWebSearchesPerMonth !== null) {
        const searchStatus = await this.usageService.getStatus(
          session.userId,
          'web_searches',
          session.entitlements.maxWebSearchesPerMonth,
        );
        webSearchAllowed = searchStatus.canUse;
        webSearchUsed = searchStatus.used;
        webSearchLimit = searchStatus.limit;
      }
      // A plan with zero allowance ever (limit 0) is excluded from the
      // feature outright; a plan with some allowance that's run dry this
      // month is a temporary cap — the client shows a different message
      // for each, so the two are never collapsed into one reason.
      const webSearchBlockReason: 'quota_exhausted' | 'plan_excluded' | undefined = webSearchAllowed
        ? undefined
        : webSearchLimit === 0
          ? 'plan_excluded'
          : 'quota_exhausted';

      // Load document context: conversation attachments + field resources (Resources tab).
      const documentContext = await this.conversationService
        .getFullDocumentContext(session.conversationId, session.userId)
        .catch((err) => {
          this.logger.warn(`Failed to load document context: ${describeError(err)}`);
          return null;
        });

      const outputLanguage = session.isGuest ? 'en' : await this.settingsService.getEffectiveLanguage(session.userId);
      const systemPrompt = this.claudeService.buildSystemPrompt(
        session.fieldName,
        session.cachedAiMemory ?? undefined,
        documentContext,
        documentGenerationEnabled,
        session.isGuest,
        documentUnavailableReason,
        session.entitlements?.allowedDocumentDepths,
        outputLanguage,
      );

      // Load all images attached to this conversation — passed as image content
      // blocks on every AI call so the AI can still answer questions about an
      // image several messages after it was uploaded.
      const conversationImages = await this.conversationService
        .getConversationImagesForAI(session.conversationId, session.userId)
        .catch(() => [] as DbConversationImage[]);

      const visionImages: ClaudeConversationImage[] = conversationImages.map((img) => ({
        mimeType: img.mime_type as ClaudeConversationImage['mimeType'],
        imageBase64: img.image_base64,
        filename: img.filename,
      }));

      // Captured inside onDocumentRequest, read inside onDone to link the
      // assistant message permanently to the generated document record, and
      // to build a real confirmation if Claude's own follow-up text comes
      // back empty — a successful generation must never be masked by the
      // generic "didn't quite catch that" fallback below.
      let generatedDocId: string | null = null;
      let generatedDocTitle: string | null = null;
      let generatedDocUrl: string | null = null;

      // Stable job ID emitted in document:generating so the client can correlate
      // document:ready / document:failed events back to the originating request.
      const docJobId = documentGenerationEnabled ? randomUUID() : '';
      // Correlates a feature:unavailable event (e.g. a blocked web search)
      // back to this specific turn — there's no assistant message id yet at
      // the point the event fires, since it can happen mid-stream before
      // the response is saved.
      const turnId = randomUUID();

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

          onDone: async (fullText: string, inputTokens: number, outputTokens: number, webSearchCalls = 0) => {
            // Safety net: if Claude returned nothing (rare but possible with very garbled
            // or ambiguous input), synthesise a clarification response so the user is
            // never left staring at a blank screen. Emit it as a token first so the
            // frontend renders it identically to a streamed response.
            //
            // A document that actually finished generating this turn is never covered
            // by this fallback — Claude's own confirmation text coming back empty is
            // not evidence the request was unclear; document:ready already told the
            // client generation succeeded, so the chat bubble must say so too instead
            // of contradicting it with "I didn't quite catch that."
            const UNCLEAR_FALLBACK = buildUnclearFallback(outputLanguage, session.fieldName ?? 'my industry');

            const DOCUMENT_READY_FALLBACK = generatedDocUrl
              ? buildDocumentReadyFallback(outputLanguage, generatedDocTitle ?? 'Untitled', generatedDocUrl)
              : UNCLEAR_FALLBACK;

            const fallback = generatedDocId ? DOCUMENT_READY_FALLBACK : UNCLEAR_FALLBACK;
            const responseText = fullText.trim() ? fullText : fallback;

            if (!fullText.trim()) {
              this.logger.warn(
                `[${client.id}] Empty AI response — sending ${generatedDocId ? 'document-ready' : 'clarification'} fallback`,
              );
              client.emit('ai:token', { token: fallback });
            }

            await this.conversationService.saveMessage({
              conversationId: session.conversationId,
              userId: session.userId,
              role: 'assistant',
              content: responseText,
              tokensUsed: inputTokens + outputTokens,
              latencyMs: Date.now() - aiStartTime,
              // Link this message to the generated document so it persists in history.
              documentId: generatedDocId ?? undefined,
            });

            this.claudeService
              .generateConversationTitle(userMessage, responseText, session.fieldName, outputLanguage)
              .then(async (title) => {
                const wasSet = await this.conversationService.setTitle(session.conversationId, session.userId, title);
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
            } else if (session.entitlements) {
              this.usageService
                .tryConsume(session.userId, 'messages', 1, session.entitlements.maxMessagesPerMonth)
                .catch((err) => this.logger.error(`Failed to record message usage (trace=${session.traceId}): ${describeError(err)}`));
            }

            if (session.entitlements) {
              if (generatedDocId && documentUsageLimit !== null) {
                this.usageService
                  .tryConsume(session.userId, 'documents', 1, documentUsageLimit)
                  .catch((err) => this.logger.error(`Failed to record document usage (trace=${session.traceId}): ${describeError(err)}`));
              }
              if (webSearchCalls > 0) {
                this.usageService
                  .tryConsume(session.userId, 'web_searches', webSearchCalls, session.entitlements.maxWebSearchesPerMonth)
                  .catch((err) => this.logger.error(`Failed to record web search usage (trace=${session.traceId}): ${describeError(err)}`));
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
                this.logger.log(`[${client.id}] Document generation requested`);
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
                    pages: req.pages,
                    allowedDepths: session.entitlements?.allowedDocumentDepths,
                  });

                  // Capture doc info — onDone picks it up to link the assistant
                  // message and to build a fallback confirmation if needed.
                  generatedDocId = result.docId;
                  generatedDocTitle = req.title;
                  generatedDocUrl = result.downloadUrl;

                  client.emit('document:ready', {
                    jobId: docJobId,
                    docId: result.docId,
                    title: req.title,
                    topic: req.topic,
                    format: req.format ?? 'docx',
                    downloadUrl: result.downloadUrl,
                  });

                  this.logger.log(`[${client.id}] Document ready (doc ${result.docId})`);

                  // Fire-and-forget push notification — socket already delivered the event,
                  // so push is a best-effort duplicate for users who may have closed the tab.
                  this.pushNotificationService
                    .sendToUser(session.userId, {
                      title: 'Your document is ready',
                      body: req.title,
                      data: { docId: result.docId, downloadUrl: result.downloadUrl, jobId: docJobId },
                    })
                    .catch((err) => this.logger.warn(`Push notification failed for doc ${result.docId}: ${describeError(err)}`));
                  return result;
                } catch (err) {
                  this.logger.error(`[${client.id}] Document generation failed: ${describeError(err)}`);
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

          onWebSearchBlocked: (info) => {
            this.emitFeatureUnavailable(client, {
              feature: 'web_search',
              reason: info.reason,
              message:
                info.reason === 'plan_excluded'
                  ? 'Upgrade your account to use this feature.'
                  : `You've used all ${webSearchLimit} web searches included in your plan this month. Upgrade for more.`,
              used: webSearchUsed,
              limit: webSearchLimit,
              conversationId: session.conversationId,
              turnId,
            });
          },
        },
        {
          // Offer web search for text requests, and for voice turns that
          // look document-adjacent (so a voice-triggered document still
          // gets research-enriched) — voice search stays off by default
          // for response latency otherwise. Offered independently of quota:
          // the tool stays registered even when blocked, so Claude's own
          // tool-use judgment — not a keyword guess — is what determines
          // whether a search was actually needed this turn; see
          // webSearchBlockReason for how a needed-but-blocked call is handled.
          enableWebSearch: inputType === 'text' || documentIntentHint,
          webSearchBlockReason,
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

  /**
   * Native mobile clients stream raw linear16 PCM with no container at all
   * (see providerConnectOptions.audioFormat) — unlike web's MediaRecorder
   * output, which already carries a real WebM/Opus header. Deepgram is fine
   * with the raw stream (it's told the encoding explicitly over the
   * connection), but anything built from that same captured buffer and
   * handed to Cloudinary needs a real container first, or Cloudinary's
   * format auto-detection rejects it outright — consistently, not
   * occasionally, since raw PCM never has recognizable file-format bytes.
   * No-op for web/container sessions, where audioFormat is undefined and
   * the buffer already has a valid header from the first chunk.
   */
  private prepareAudioForUpload(session: ActiveSession, audioData: Buffer): Buffer {
    const format = session.providerConnectOptions.audioFormat;
    if (format?.encoding !== 'linear16') return audioData;
    return wrapPcm16AsWav(audioData, format.sampleRate ?? 16000, format.channels ?? 1);
  }

  private async buildSingleSpeakerVoiceProfile(client: Socket, session: ActiveSession): Promise<void> {
    this.logger.log(
      `[${client.id}] Building owner voice profile from single-speaker session (${session.audioBufferBytes} bytes, ${session.singleSpeakerSpeechSeconds.toFixed(1)} s speech)`,
    );

    const audioData = Buffer.concat(session.audioBuffer);
    session.audioBuffer = [];
    session.audioBufferBytes = 0;

    try {
      const uploadResult = await this.uploadService.uploadBuffer(
        this.prepareAudioForUpload(session, audioData),
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
        this.logger.log(`[${client.id}] Owner voice profile reinforced from single-speaker session`);
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
        this.logger.log(`[${client.id}] Owner voice profile enrolled from single-speaker session`);
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
        this.prepareAudioForUpload(session, audioData),
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
          `[${client.id}] Voice enrolled: owner=speaker ${dominantSpeaker}`,
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
      client.emit('speaker:identified', { ...this.speakerScope(session),
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
        this.prepareAudioForUpload(session, audioData),
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
      `identified=${result.identified}, ` +
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

        session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => this.flipDualTurn(turn));

        this.conversationService.relabelSpeakers(session.conversationId, session.userId).catch((err) =>
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

      session.dualSpeakerHistory = session.dualSpeakerHistory.map((turn) => this.flipDualTurn(turn));

      this.conversationService.relabelSpeakers(session.conversationId, session.userId).catch((err) =>
        this.logger.error(`[${client.id}] relabelSpeakers (contact flip) failed:`, err),
      );

      this.logger.log(
        `[${client.id}] Speaker ${deepgramSpeakerId} identified as a contact ` +
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

    client.emit('speaker:identified', { ...this.speakerScope(session),
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
    // The speaker number below belongs to THIS provider connection; the voice-ID
    // call is async, so pin the epoch now and compare when it returns.
    const epoch = session.providerEpoch;

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
      client.emit('speaker:identified', { ...this.speakerScope(session, epoch),  deepgramSpeakerId, speakerId: null, speakerLabel: anonymousLabel, method: 'diarization' });
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
        this.prepareAudioForUpload(session, audioData), UploadFolder.VOICE_SAMPLES, `multi-spk-id-${client.id}-${deepgramSpeakerId}`, 'video',
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
      `identified=${result.identified}, candidates=${result.candidatesChecked}`,
    );

    // ── Gap 4: always resolve to local speakers.id, never the external voice ID ──
    let resolvedName: string;
    let resolvedSpeakerId: string | null = null;
    let resolvedVoiceSpeakerId: string | null = null;
    let method: 'voice_id' | 'diarization' = 'diarization';

    // The provider connection was replaced while voice-ID ran: this speaker number
    // now refers to a different connection's numbering, so applying the result
    // could label (or rewrite) the wrong person. Drop it; the old segments keep
    // their diarization labels and can still be corrected explicitly.
    if (session.providerEpoch !== epoch) {
      this.logger.warn(`[${client.id}] Dropping stale voice-ID result for speaker ${deepgramSpeakerId} (epoch ${epoch} → ${session.providerEpoch})`);
      return;
    }

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
          `[${client.id}] Speaker ${deepgramSpeakerId} consolidated with prior speaker ${priorDgramId} — same voice print`,
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
        `— will retry`,
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
        t.deepgramSpeakerId === deepgramSpeakerId && t.providerEpoch === epoch
          ? { ...t, speakerLabel: resolvedName, speakerId: resolvedSpeakerId, identificationMethod: 'voice_id' as const }
          : t;

      session.multiSpeakerHistory = session.multiSpeakerHistory.map(updateTurn);
      session.pendingMultiSpeakerTurns = session.pendingMultiSpeakerTurns.map(updateTurn);

      // ── Retroactively update segment rows saved before identification ─────
      this.conversationService.updateTranscriptSpeakerByDeepgramId({
        conversationId: session.conversationId,
        userId: session.userId,
        deepgramSpeakerId,
        speakerId: resolvedSpeakerId,
        speakerLabel: resolvedName,
        identificationMethod: 'voice_id',
        recordingSessionId: session.recordingSessionId,
        providerEpoch: epoch,
      }).catch((err) =>
        this.logger.warn(`[${client.id}] retroactive segment update failed (non-fatal): ${describeError(err)}`),
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
        this.logger.warn(`[${client.id}] Failed to persist voice-ID participant: ${describeError(err)}`),
      );
    }

    client.emit('speaker:identified', { ...this.speakerScope(session, epoch),
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
      // Keep the recognised text but do NOT guess who said it: attributing it to
      // the last-seen ("dominant") speaker would present uncertain attribution
      // as fact, and could fabricate or merge speakers.
      return [{
        deepgramSpeakerId: null,
        providerEpoch: session.providerEpoch,
        speakerId: null,
        speakerLabel: UNATTRIBUTED_SPEAKER_LABEL,
        text: fallbackTranscript.trim(),
        confidence,
        startMs: null,
        endMs: null,
        identificationMethod: 'unknown',
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
        providerEpoch: session.providerEpoch,
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
  /** Swaps owner/other when the owner assignment is corrected; unattributed text stays unattributed. */
  private flipDualTurn(turn: DualSpeakerTurn): DualSpeakerTurn {
    if (turn.speaker === 'unknown') return turn;
    return { ...turn, speaker: turn.speaker === 'owner' ? 'other' : 'owner' };
  }

  /** Additive scope fields so clients can tell which provider connection a speaker number belongs to. */
  private speakerScope(session: ActiveSession, epoch: number = session.providerEpoch) {
    return { recordingSessionId: session.recordingSessionId, providerEpoch: epoch };
  }

  /** The epoch a client-supplied correction applies to: a valid past/current epoch, else the current one. */
  private resolveCorrectionEpoch(session: ActiveSession, requested: unknown): number {
    return typeof requested === 'number' && Number.isInteger(requested) && requested >= 0 && requested <= session.providerEpoch
      ? requested
      : session.providerEpoch;
  }

  /**
   * A new provider connection restarts speaker numbering, so everything the
   * session learned about "speaker N" belongs to the old connection. Drop it,
   * so a new connection's speaker 0 can't inherit an earlier speaker 0's
   * name, voice-ID state or audio. Persisted segments keep their own epoch.
   */
  private resetSpeakerStateForNewEpoch(session: ActiveSession): void {
    session.resolvedSpeakers.clear();
    session.identifiedDeepgramSpeakers.clear();
    session.anonymousSpeakerLabels.clear();
    session.speakerIdentificationTriggered.clear();
    session.speakerIdentificationFailed.clear();
    session.speakerIdentificationAtSeconds.clear();
    session.speakerWordSeconds.clear();
    session.speakerAudioBuffers.clear();
    session.speakerAudioBytes.clear();
    session.currentDominantSpeaker = 0;
  }

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
      providerEpoch: t.providerEpoch ?? session.providerEpoch,
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

    const turns: MultiSpeakerTurn[] = [...session.pendingMultiSpeakerTurns];
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
          ...this.speakerScope(session),
        });
      }
      return false;
    }

    if (!(await this.checkMessageQuota(client, session))) return false;

    // Another flush (utterance-end vs Stop) may have run while the quota check was
    // awaited. Re-read the live queue and processing flag: from here to the call
    // below everything is synchronous, so exactly one flush takes any given turns.
    if (session.isProcessingAI) {
      client.emit('ai:skipped', { reason: 'already_processing' });
      return false;
    }
    const liveTurns = [...session.pendingMultiSpeakerTurns];
    if (liveTurns.length === 0) return false;
    turns.length = 0;
    turns.push(...liveTurns);

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
        if (session.transcriptConfidences.length > SESSION_BOUNDS.MAX_CONFIDENCE_SAMPLES) {
          session.transcriptConfidences.splice(0, session.transcriptConfidences.length - SESSION_BOUNDS.MAX_CONFIDENCE_SAMPLES);
          this.noteBoundHit(session, 'confidenceTrim');
        }
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
        this.enforceSessionBounds(client, session);
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
          ...this.speakerScope(session),
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
        this.enforceSessionBounds(client, session);

        // No word-level speaker data: the text is real, who said it is not known.
        // Keep it as unattributed instead of dropping it or guessing owner/other.
        const unattributedText = words.length === 0 ? (result.transcript ?? '').trim() : '';
        if (unattributedText) {
          session.dualSpeakerHistory.push({ speaker: 'unknown', text: unattributedText });
          session.pendingUnattributedText = (session.pendingUnattributedText + ' ' + unattributedText).trim();
        }
        this.enforceSessionBounds(client, session);

        session.accumulatedTranscript =
          (session.accumulatedTranscript + ' ' + result.transcript).trim();

        client.emit('transcript:update', {
          transcript: session.accumulatedTranscript,
          isFinal: true,
          confidence: result.confidence,
          ...(unattributedText ? { unattributed: unattributedText, attribution: 'unknown' } : {}),
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

          await this.flushDualSpeakerPending(client, session, 8);
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
          this.logger.log(`UtteranceEnd filtered [${quality.reason}]: words=${countWords(transcript)} (conf=${avgConfidence.toFixed(2)})`);
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
        } else if (!(await this.checkMessageQuota(client, session))) {
          return;
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
      this.logger.warn(`[${client.id}] provider transport failure (${source}) epoch=${epoch}: ${describeError(error)}`);
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
    const cause = providerDisruptionCause(reason);
    this.logLifecycle(session, 'provider_disruption', { cause, recoveryId });
    client.emit('session:recovering', {
      recoveryId,
      reason,
      cause,
      correlation: this.correlation(session),
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

        // Replay the buffered audio through the NEW connection first. If the provider
        // refuses a chunk this connection is useless: discard it (its emitter has no
        // listeners, so nothing it produced is lost), keep the whole buffer intact, and
        // let the next attempt replay from the start — never a "recovered" session that
        // silently lost the replay.
        const replay = this.flushRecoveryBuffer(session, sendAudio);
        if (replay.failed) {
          try { close(); } catch (_) {}
          this.logLifecycle(session, 'replay_failed', { attempt, bufferedBytes: session.recoveryAudioBufferBytes, replayedBytes: replay.flushedBytes });
          throw new Error('provider refused replay of buffered audio');
        }

        session.deepgramEmitter = emitter;
        session.sendAudio = sendAudio;
        session.sendFinalize = sendFinalize;
        session.closeDeepgram = close;
        session.providerEpoch += 1;
        this.resetSpeakerStateForNewEpoch(session);
        this.attachDeepgramListeners(client, session, emitter);

        const droppedDurationMs = replay.droppedDurationMs;
        // Dropped bytes are a loss even when the outage was shorter than the clock tick.
        const audioLost = droppedDurationMs > 0 || replay.droppedBytes > 0;

        // Back to 'active' so a *later* disruption of the new connection is
        // recoverable too (a stale event from the replaced connection is still
        // rejected by the epoch check above).
        session.providerState = 'active';
        session.currentRecoveryId = null;

        this.logger.log(
          `[${client.id}] provider recovery ${recoveryId} succeeded on attempt ${attempt} ` +
          `(epoch=${session.providerEpoch}, droppedDurationMs=${droppedDurationMs})`,
        );

        this.flushRecoveryLoss(client, session);
        this.logLifecycle(session, 'provider_recovered', { recoveryId, attempt, droppedDurationMs, replayedBytes: replay.flushedBytes, droppedBytes: replay.droppedBytes });
        client.emit('session:recovered', {
          recoveryId,
          correlation: this.correlation(session),
          ...(audioLost ? { lossReason: 'recovery_buffer_bound' satisfies AudioLossReason, droppedAudioBytes: replay.droppedBytes } : {}),
          providerEpoch: session.providerEpoch,
          audioGapDetected: audioLost,
          droppedDurationMs,
        });
        return;
      } catch (err) {
        this.logger.warn(
          `[${client.id}] provider recovery ${recoveryId} attempt ${attempt}/${PROVIDER_RECOVERY_MAX_ATTEMPTS} failed: ${describeError(err)}`,
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
        traceId: session.traceId,
        recoveryId,
        incidentId,
        providerEpoch: session.providerEpoch,
        reason,
        closeCode: closeInfo?.code ?? null,
      },
    });

    this.flushRecoveryLoss(client, session);
    const lostAudioBytes = (session.recoveryAudioBufferBytes ?? 0) + (session.recoveryDroppedBytes ?? 0);
    this.logLifecycle(session, 'session_terminal', { reason: 'provider_recovery_exhausted' satisfies SessionTerminalReason, cause: providerDisruptionCause(reason), incidentId, lostAudioBytes });
    client.emit('session:degraded', {
      recoveryId,
      reason: 'provider_recovery_exhausted' satisfies SessionTerminalReason,
      cause: providerDisruptionCause(reason),
      // Audio that was buffered or dropped during the outage and never reached a provider.
      ...(lostAudioBytes > 0 ? { lossReason: (session.recoveryDroppedBytes ?? 0) > 0 ? 'recovery_buffer_bound' : 'replay_failed' satisfies AudioLossReason, lostAudioBytes } : {}),
      correlation: this.correlation(session),
      category: 'provider_recovery_failed',
      recoverable: false,
      incidentId,
      message: 'We could not restore your voice connection after several attempts. Please start a new recording.',
    });

    this.cleanupSession(client.id);
  }

  /** Buffers one audio chunk while providerState === 'recovering', bounded by both byte count and age. */
  /**
   * Admits one chunk to the bounded recovery buffer and reports exactly what happened:
   * whether THIS chunk was retained, and which older chunks were evicted (age) to make room.
   * Nothing is dropped without being returned, so callers can report the loss.
   */
  private bufferAudioForRecovery(
    session: ActiveSession,
    buffer: Buffer,
    meta: { streamId?: string; sequence?: number } = {},
  ): { retained: boolean; evicted: Array<{ streamId: string | null; sequence: number | null; bytes: number }> } {
    const now = Date.now();
    const evicted: Array<{ streamId: string | null; sequence: number | null; bytes: number }> = [];

    while (
      session.recoveryAudioBuffer.length > 0 &&
      now - session.recoveryAudioBuffer[0].enqueuedAt > this.PROVIDER_RECOVERY_BUFFER_MAX_MS
    ) {
      const dropped = session.recoveryAudioBuffer.shift()!;
      session.recoveryAudioBufferBytes -= dropped.chunk.length;
      session.recoveryDroppedBytes = (session.recoveryDroppedBytes ?? 0) + dropped.chunk.length;
      evicted.push({ streamId: dropped.streamId ?? null, sequence: dropped.sequence ?? null, bytes: dropped.chunk.length });
      this.noteBoundHit(session, 'recoveryBufferAgeEvict');
    }

    if (session.recoveryAudioBufferBytes + buffer.length > this.PROVIDER_RECOVERY_BUFFER_MAX_BYTES) {
      // Byte cap reached — drop this (newest) chunk so the buffer keeps
      // replaying audio closest to the moment the outage started.
      if (session.recoveryBufferOverflowStartedAt === null) {
        session.recoveryBufferOverflowStartedAt = now;
      }
      session.recoveryDroppedBytes = (session.recoveryDroppedBytes ?? 0) + buffer.length;
      this.noteBoundHit(session, 'recoveryBufferByteOverflow');
      return { retained: false, evicted };
    }

    session.recoveryAudioBuffer.push({ chunk: buffer, enqueuedAt: now, streamId: meta.streamId, sequence: meta.sequence });
    session.recoveryAudioBufferBytes += buffer.length;
    this.sampleSessionMetrics(session);
    return { retained: true, evicted };
  }

  /**
   * Reports audio the recovery buffer could not keep as an explicit, machine-readable
   * audio:loss event (ids, sequence range and byte/chunk counts only). The audio:ack for such
   * a chunk still means only "the gateway received it" — this event is what says it was NOT kept.
   * Throttled to one event per second during a sustained outage; the remainder is flushed
   * before session:recovered / session:degraded.
   */
  private recordRecoveryLoss(
    client: Socket,
    session: ActiveSession,
    lost: Array<{ streamId: string | null; sequence: number | null; bytes: number }>,
  ): void {
    if (lost.length === 0) return;
    const acc = session.pendingLoss ?? { streamId: null, firstSequence: null, lastSequence: null, chunks: 0, bytes: 0 };
    for (const l of lost) {
      acc.streamId = acc.streamId ?? l.streamId;
      if (l.sequence !== null) {
        acc.firstSequence = acc.firstSequence === null ? l.sequence : Math.min(acc.firstSequence, l.sequence);
        acc.lastSequence = acc.lastSequence === null ? l.sequence : Math.max(acc.lastSequence, l.sequence);
      }
      acc.chunks += 1;
      acc.bytes += l.bytes;
    }
    session.pendingLoss = acc;
    const now = Date.now();
    if (!session.lastLossEmitAt || now - session.lastLossEmitAt >= 1_000) this.flushRecoveryLoss(client, session);
  }

  private flushRecoveryLoss(client: Socket, session: ActiveSession): void {
    const acc = session.pendingLoss;
    if (!acc) return;
    session.pendingLoss = undefined;
    session.lastLossEmitAt = Date.now();
    this.logLifecycle(session, 'audio_loss', { reason: 'recovery_buffer_bound', chunks: acc.chunks, bytes: acc.bytes });
    client.emit('audio:loss', {
      reason: 'recovery_buffer_bound' satisfies AudioLossReason,
      streamId: acc.streamId,
      firstSequence: acc.firstSequence,
      lastSequence: acc.lastSequence,
      chunks: acc.chunks,
      bytes: acc.bytes,
      correlation: this.correlation(session),
    });
  }

  /**
   * Replays the bounded recovery buffer, in order, through `send` (the NEW provider
   * connection's sender; defaults to the session's current one). Returns an explicit
   * outcome: on `failed` the provider refused a chunk, nothing is cleared, and the
   * caller must treat the replay as not having happened (retry or report loss).
   */
  private flushRecoveryBuffer(
    session: ActiveSession,
    send: (chunk: Buffer) => boolean | void = session.sendAudio,
  ): { flushedBytes: number; droppedDurationMs: number; droppedBytes: number; failed: boolean } {
    let flushedBytes = 0;
    for (const { chunk } of session.recoveryAudioBuffer) {
      if (send(chunk) === false) {
        return { flushedBytes, droppedDurationMs: 0, droppedBytes: session.recoveryDroppedBytes ?? 0, failed: true };
      }
      flushedBytes += chunk.length;
    }

    const droppedDurationMs = session.recoveryBufferOverflowStartedAt !== null
      ? Date.now() - session.recoveryBufferOverflowStartedAt
      : 0;
    const droppedBytes = session.recoveryDroppedBytes ?? 0;

    session.recoveryAudioBuffer = [];
    session.recoveryAudioBufferBytes = 0;
    session.recoveryBufferOverflowStartedAt = null;
    session.recoveryDroppedBytes = 0;

    return { flushedBytes, droppedDurationMs, droppedBytes, failed: false };
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

    // Meter voice-minutes usage against the tier's monthly cap by the
    // Deepgram-connected duration of this session — the same "connected
    // minutes, not speaking minutes" driver the ledger identifies as the
    // real cost (a live session held open through silence still bills).
    // Fire-and-forget: cleanupSession must stay synchronous for its callers.
    if (!session.isGuest && session.entitlements) {
      const elapsedSeconds = Math.round((Date.now() - session.startedAt) / 1000);
      const maxMinutes = session.entitlements.maxVoiceMinutesPerMonth;
      if (elapsedSeconds > 0) {
        this.usageService
          .tryConsume(session.userId, 'voice_seconds', elapsedSeconds, maxMinutes !== null ? maxMinutes * 60 : null)
          .catch((err) => this.logger.error(`Failed to record voice usage (trace=${session.traceId}): ${describeError(err)}`));
      }
    }

    this.sampleSessionMetrics(session);
    this.logger.log(
      `Session cleaned up: ${socketId} recordingSession=${session.recordingSessionId} epoch=${session.providerEpoch} ` +
      `turns=${session.acceptedTurnSeq ?? 0}/${session.settledTurnSeq ?? 0} metrics=${JSON.stringify(session.metrics ? snapshotMetrics(session.metrics) : null)}`,
    );
  }
}
