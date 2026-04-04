import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeepgramClient } from '@deepgram/sdk';
import { EventEmitter } from 'events';

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptResult {
  transcript: string;
  isFinal: boolean;
  confidence: number;
  words: TranscriptWord[];
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

// Full V1Socket interface including waitForOpen()
interface V1Socket {
  on(event: 'open',    cb: () => void): void;
  on(event: 'message', cb: (data: DeepgramMessagePayload) => void): void;
  on(event: 'close',   cb: (event: unknown) => void): void;
  on(event: 'error',   cb: (err: Error) => void): void;
  connect(): V1Socket;           // starts the WS handshake, returns this
  waitForOpen(): Promise<void>;  // resolves once readyState === OPEN
  sendMedia(data: Buffer): void;
  sendCloseStream(msg?: object): void;
  close(): void;
  readyState: number;
}

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

  async createLiveSession(sessionId: string): Promise<{
    emitter: EventEmitter;
    sendAudio: (chunk: Buffer) => void;
    close: () => void;
  }> {
    const emitter = new EventEmitter();

    // ── Step 1: build the V1Socket (does NOT open the connection yet) ─────────
    // V1Client.connect() returns a V1Socket immediately without waiting for open.
    // The socket is in CONNECTING state, not OPEN — readyState will be 0 here.
    const rawSocket = (await this.deepgram.listen.v1.connect({
      Authorization:    `Token ${this.apiKey}`,
      model:            'nova-2',
      language:         'en-US',
      smart_format:     'true',
      interim_results:  'true',
      utterance_end_ms: '1000',
      vad_events:       'true',
      // No encoding/sample_rate — let Deepgram auto-detect from webm/opus container
    })) as unknown as V1Socket;

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
    });

    rawSocket.on('close', () => {
      this.logger.log(`[${sessionId}] Deepgram connection closed`);
      emitter.emit('close');
    });

    rawSocket.on('error', (err: Error) => {
      this.logger.error(`[${sessionId}] Deepgram error: ${err.message}`);
      emitter.emit('error', err);
    });

    // ── Step 3: call connect() to start WS handshake, then waitForOpen() ─────
    // V1Socket.connect() calls socket.reconnect() to start the handshake.
    // waitForOpen() returns a promise that resolves only when readyState === OPEN.
    // Without this, audio arrives before the socket is open → readyState=3 (CLOSED).
    const socket = rawSocket.connect();

    // waitForOpen() can reject (TIMEOUT) when Deepgram is unreachable or the API
    // key is invalid.  Catch it here so we can clean up and surface a proper error
    // to the gateway rather than leaving an orphaned socket.
    try {
      await socket.waitForOpen();
    } catch (err) {
      this.logger.error(`[${sessionId}] Deepgram waitForOpen failed: ${(err as Error).message}`);
      try { socket.close(); } catch (_) {}
      emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
      throw err; // re-throw so handleSessionStart emits error to the WS client
    }

    this.logger.log(`[${sessionId}] Deepgram socket ready (readyState=${socket.readyState})`);

    // ── sendAudio ─────────────────────────────────────────────────────────────
    const sendAudio = (chunk: Buffer): void => {
      try {
        if (socket.readyState === 1) {
          socket.sendMedia(chunk);
        } else {
          this.logger.warn(`[${sessionId}] sendAudio skipped — readyState=${socket.readyState}`);
        }
      } catch (err) {
        this.logger.warn(`[${sessionId}] sendMedia failed: ${(err as Error).message}`);
      }
    };

    // ── close ─────────────────────────────────────────────────────────────────
    // readyState: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
    // Only send the close-stream signal when the socket is actually open (1).
    // Calling close() on state 0 or 3 is what triggers the secondary ws crash.
    const close = (): void => {
      try {
        if (socket.readyState === 1) socket.sendCloseStream();
      } catch (_) {}
      try {
        if (socket.readyState === 0 || socket.readyState === 1) socket.close();
      } catch (_) {}
    };

    return { emitter, sendAudio, close };
  }
}