import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeepgramClient } from '@deepgram/sdk';
import { EventEmitter } from 'events';
import { ProviderCloseInfo } from '../interfaces/provider-session.types';

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
}

export interface TranscriptResult {
  transcript: string;
  isFinal: boolean;
  confidence: number;
  words: TranscriptWord[];
}

export interface DeepgramLiveAudioFormat {
  encoding?: 'linear16';
  sampleRate?: number;
  channels?: number;
}

interface DeepgramMessagePayload {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: TranscriptWord[];
    }>;
  };
}

interface DeepgramCloseEvent {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

// Full V1Socket interface including waitForOpen()
interface V1Socket {
  on(event: 'open',    cb: () => void): void;
  on(event: 'message', cb: (data: DeepgramMessagePayload) => void): void;
  on(event: 'close',   cb: (event: DeepgramCloseEvent) => void): void;
  on(event: 'error',   cb: (err: Error) => void): void;
  connect(): V1Socket;           // starts the WS handshake, returns this
  waitForOpen(): Promise<void>;  // resolves once readyState === OPEN
  sendMedia(data: Buffer): void;
  sendCloseStream(msg?: object): void;
  sendKeepAlive(msg: { type: string }): void;
  close(): void;
  readyState: number;
}

// Deepgram closes a live-streaming WS after ~10 s of receiving no audio
// (NET-0001). During natural pauses in conversation (or before the mic
// starts streaming) no media frames are sent, so without a periodic
// KeepAlive the provider silently drops the connection and the frontend
// sees a spurious "session:degraded" / reconnect prompt. Ping well under
// the 10 s window to keep the socket alive through normal silence.
const DEEPGRAM_KEEPALIVE_INTERVAL_MS = 6_000;

@Injectable()
export class DeepgramService implements OnModuleInit {
  private readonly logger = new Logger(DeepgramService.name);
  private deepgram: DeepgramClient;
  private apiKey: string;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.apiKey = this.configService.get<string>('voice.deepgramApiKey') ?? '';
    if (!this.apiKey) throw new Error('DEEPGRAM_API_KEY is not configured');
    this.deepgram = new DeepgramClient({ apiKey: this.apiKey });
    this.logger.log('Deepgram client initialized (SDK v5)');
  }

  async createLiveSession(sessionId: string, options?: { diarize?: boolean; utteranceEndMs?: number; meetingMode?: boolean; audioFormat?: DeepgramLiveAudioFormat; connectionTimeoutMs?: number }): Promise<{
    emitter: EventEmitter;
    sendAudio: (chunk: Buffer) => void;
    close: () => void;
  }> {
    const emitter = new EventEmitter();
    let keepAliveTimer: NodeJS.Timeout | undefined;
    const connectionTimeoutMs = options?.connectionTimeoutMs ?? 10_000;
    // Diagnostics captured for the eventual 'close' event — lets recovery
    // orchestration in the gateway distinguish a genuinely dead connection
    // from one that was simply idle, and correlate error+close pairs.
    let lastAudioAt: number | null = null;
    let lastKeepAliveAt: number | null = null;
    let sawError = false;

    // ── Step 1: build the V1Socket (does NOT open the connection yet) ─────────
    const rawSocket = (await this.deepgram.listen.v1.connect({
      Authorization:           `Token ${this.apiKey}`,
      // nova-2-meeting is specifically trained on multi-speaker meeting audio
      // and handles cross-talk, echo, and background noise far better than
      // the general-purpose nova-2 model.  Use it for all diarized sessions.
      model:                   options?.meetingMode ? 'nova-2-meeting' : 'nova-2',
      language:                'en-US',
      smart_format:            'true',
      interim_results:         'true',
      // Dual-speaker mode needs a longer end-of-utterance window so that
      // back-and-forth conversation doesn't fragment into word-sized chunks.
      utterance_end_ms:        String(options?.utteranceEndMs ?? 1500),
      vad_events:              'true',
      ...(options?.audioFormat?.encoding === 'linear16'
        ? {
            encoding: 'linear16',
            sample_rate: String(options.audioFormat.sampleRate ?? 16000),
            channels: String(options.audioFormat.channels ?? 1),
          }
        : {}),
      // Enable speaker diarization when requested (dual-speaker mode)
      ...(options?.diarize ? { diarize: 'true' } : {}),
      // Fail fast: don't retry on connection failure during session start.
      // The gateway catch block will surface a clear error to the client instead
      // of leaving 30 zombie reconnect attempts running in the background.
      reconnectAttempts:       0,
      // Close the TCP connection if the WS upgrade doesn't complete in time.
      connectionTimeoutInSeconds: Math.ceil(connectionTimeoutMs / 1000),
    })) as unknown as V1Socket;

    // The SDK's V1Socket.close() synchronously calls the underlying
    // ReconnectingWebSocket's close(), which — if the raw ws is still
    // CONNECTING — triggers `ws`'s abortHandshake path. That emits an
    // 'error' event on the raw socket via process.nextTick, i.e. *after*
    // V1Socket.close() has already torn down its own error listener. If
    // nothing else is listening at that point, Node treats it as an
    // unhandled EventEmitter error and crashes the whole process. Attach a
    // permanent, never-removed no-op listener directly on the underlying
    // ReconnectingWebSocket so that race can never escalate past this
    // service, regardless of the SDK's own listener bookkeeping.
    const underlyingSocket = (rawSocket as unknown as { socket?: { addEventListener?: (t: string, l: (...a: unknown[]) => void) => void } }).socket;
    underlyingSocket?.addEventListener?.('error', () => {});

    // ── Step 2: register event handlers BEFORE calling connect()/waitForOpen() ─
    // Must attach handlers first so we don't miss the 'open' event.
    rawSocket.on('open', () => {
      this.logger.log(`[${sessionId}] Deepgram connection opened`);
      emitter.emit('open');
    });

    rawSocket.on('message', (data: DeepgramMessagePayload) => {
      this.logger.debug(`[${sessionId}] Deepgram msg type=${data?.type}`);

      if (data?.type === 'Results') {
        const alt = data?.channel?.alternatives?.[0];
        this.logger.debug(`[${sessionId}] transcript="${alt?.transcript ?? ''}" isFinal=${data.is_final}`);
        if (!alt?.transcript) return;

        emitter.emit('transcript', {
          transcript: alt.transcript,
          isFinal:    data.is_final === true,
          confidence: alt.confidence ?? 0,
          words:      alt.words ?? [],
        } satisfies TranscriptResult);
      }

      if (data?.type === 'UtteranceEnd') {
        emitter.emit('utteranceEnd');
      }

      // Deepgram sends { type: 'Error', description: '...' } as a message frame
      // before closing the WS. Route it through the error emitter so the gateway
      // can degrade the session cleanly rather than silently swallowing the error.
      if (data?.type === 'Error') {
        const msg = (data as any)?.description ?? (data as any)?.message ?? 'Deepgram stream error';
        this.logger.warn(`[${sessionId}] Deepgram stream error message: ${msg}`);
        sawError = true;
        if (emitter.listenerCount('error') > 0) {
          emitter.emit('error', new Error(msg));
        }
      }
    });

    rawSocket.on('close', (event) => {
      this.logger.log(`[${sessionId}] Deepgram connection closed code=${event?.code ?? 'n/a'} reason=${event?.reason ?? ''}`);
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      const closeInfo: ProviderCloseInfo = {
        code: event?.code ?? null,
        reason: event?.reason ?? null,
        wasClean: event?.wasClean ?? null,
        readyStateAtClose: socket.readyState,
        errorPreceded: sawError,
        lastAudioAt,
        lastKeepAliveAt,
        closedAt: Date.now(),
      };
      emitter.emit('close', closeInfo);
    });

    rawSocket.on('error', (err: Error) => {
      this.logger.error(`[${sessionId}] Deepgram error: ${err.message}`);
      sawError = true;
      // Guard: if listeners were removed (session cleanup), emitting 'error' on a
      // bare EventEmitter crashes Node.js with "Unhandled 'error' event".
      if (emitter.listenerCount('error') > 0) {
        emitter.emit('error', err);
      }
    });

    // ── Step 3: call connect() to start WS handshake, then waitForOpen() ─────
    const socket = rawSocket.connect();

    // waitForOpen() rejects with a raw ErrorEvent (not an Error instance) when
    // Deepgram rejects the connection (invalid API key, quota exceeded, network
    // failure, etc.).  Wrap it so the gateway always gets a proper Error with a
    // human-readable message, and close the socket immediately on failure so the
    // underlying ReconnectingWebSocket stops its retry loop.
    let openTimeoutHandle: NodeJS.Timeout | undefined;
    try {
      // Race waitForOpen() against a timeout so a hanging TCP connection
      // (Deepgram accepts TCP but never upgrades to WS) doesn't block forever.
      // The timer is cleared as soon as the race settles either way, so it
      // never lingers as an open handle past this call.
      await Promise.race([
        socket.waitForOpen(),
        new Promise<never>((_, reject) => {
          openTimeoutHandle = setTimeout(() => reject(new Error(`Deepgram connection timed out after ${connectionTimeoutMs} ms`)), connectionTimeoutMs);
        }),
      ]);
      clearTimeout(openTimeoutHandle);
    } catch (err) {
      clearTimeout(openTimeoutHandle);
      // Convert non-Error rejections (e.g. ErrorEvent from the WS layer) to
      // proper Error instances so callers always have a .message to log/display.
      const reason =
        err instanceof Error
          ? err.message
          : typeof (err as { message?: string }).message === 'string'
            ? (err as { message: string }).message
            : JSON.stringify(err);

      const wrappedErr = new Error(`Deepgram connection failed: ${reason}`);

      this.logger.error(`[${sessionId}] ${wrappedErr.message}`);
      // Close immediately so the SDK stops its internal retry loop. The
      // socket is still CONNECTING here, so this is exactly the abort race
      // the permanent no-op error listener above exists to absorb — this
      // try/catch only guards the synchronous call, not that async race.
      try { socket.close(); } catch (_) {}
      // Do NOT emit 'error' here — the gateway hasn't registered its emitter
      // listeners yet (it awaits this method first), so emitting would crash Node.js.
      // The thrown error propagates to the gateway's catch block instead.
      throw wrappedErr;
    }

    this.logger.log(`[${sessionId}] Deepgram socket ready (readyState=${socket.readyState})`);

    // Keep the provider socket alive through silence (see comment above the
    // interval constant) — Deepgram treats KeepAlive frames the same as audio
    // for the purposes of its inactivity timeout.
    keepAliveTimer = setInterval(() => {
      try {
        if (socket.readyState === 1) {
          socket.sendKeepAlive({ type: 'KeepAlive' });
          lastKeepAliveAt = Date.now();
        }
      } catch (err) {
        this.logger.warn(`[${sessionId}] sendKeepAlive failed: ${(err as Error).message}`);
        // A failed KeepAlive means the connection is unhealthy even though no
        // 'close'/'error' event has fired yet — surface it so the gateway can
        // start recovery instead of silently continuing to ping a dead socket.
        emitter.emit('transportFailure', { source: 'sendKeepAlive', error: err as Error });
      }
    }, DEEPGRAM_KEEPALIVE_INTERVAL_MS);

    // ── sendAudio ─────────────────────────────────────────────────────────────
    const sendAudio = (chunk: Buffer): void => {
      try {
        if (socket.readyState === 1) {
          socket.sendMedia(chunk);
          lastAudioAt = Date.now();
        } else {
          this.logger.warn(`[${sessionId}] sendAudio skipped — readyState=${socket.readyState}`);
        }
      } catch (err) {
        this.logger.warn(`[${sessionId}] sendMedia failed: ${(err as Error).message}`);
        emitter.emit('transportFailure', { source: 'sendMedia', error: err as Error });
      }
    };

    // ── close ─────────────────────────────────────────────────────────────────
    // readyState: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
    // Only send the close-stream signal when the socket is actually open (1).
    // Only call close() while OPEN. Closing a still-CONNECTING (0) socket
    // triggers the abort-handshake race described above the permanent
    // no-op error listener — leave a CONNECTING socket for the SDK's own
    // connectionTimeoutInSeconds to unwind instead of aborting it here.
    const close = (): void => {
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      try {
        if (socket.readyState === 1) socket.sendCloseStream({} as any);
      } catch (_) {}
      try {
        if (socket.readyState === 1) socket.close();
      } catch (_) {}
    };

    return { emitter, sendAudio, close };
  }
}
