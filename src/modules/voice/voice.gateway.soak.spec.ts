/**
 * Fake-timer soak: a healthy multi-speaker session driven through the REAL
 * gateway and the REAL Deepgram adapter (fake socket) for well over 20 minutes,
 * with periodic audio chunks + acks, provider KeepAlive frames and three
 * speakers. Proves there is no application-added time cutoff and that memory
 * stays inside its bounds while every accepted turn reaches persistence.
 * Idle behaviour is a separate scenario at the end.
 *
 * Set SOAK_REPORT=/some/file.json to write the redacted high-water report.
 */
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeepgramService } from './services/deepgram.service';
import { VoiceGateway } from './voice.gateway';
import { SESSION_BOUNDS } from './utils/session-metrics.util';

const mockConnect = jest.fn();
jest.mock('@deepgram/sdk', () => ({
  DeepgramClient: jest.fn().mockImplementation(() => ({
    listen: { v1: { connect: (...args: unknown[]) => mockConnect(...args) } },
  })),
}));

function fakeSocket() {
  const handlers: Record<string, (...a: any[]) => void> = {};
  const socket: any = {
    on: jest.fn((e: string, cb: (...a: any[]) => void) => { handlers[e] = cb; }),
    connect: jest.fn(),
    waitForOpen: jest.fn(() => Promise.resolve()),
    sendMedia: jest.fn(),
    sendCloseStream: jest.fn(),
    sendKeepAlive: jest.fn(),
    sendFinalize: jest.fn(),
    close: jest.fn(),
    readyState: 1,
    socket: { addEventListener: jest.fn() },
  };
  socket.connect.mockImplementation(() => socket);
  return { socket, handlers };
}

const MINUTE = 60_000;
const CHUNK_MS = 250;
const SPEAKERS = 3;

describe('voice gateway soak (fake timers)', () => {
  const emitted: Array<[string, any]> = [];
  let gateway: any;
  let client: any;
  let session: any;
  let socket: any;
  let handlers: Record<string, (...a: any[]) => void>;
  let savedUserSegments: Array<{ text: string; speakerId: number | null; startMs: number | null }>;
  let savedMessages: Array<{ role: string }>;

  beforeEach(async () => {
    jest.useFakeTimers();
    ['log', 'warn', 'error', 'debug'].forEach((m) => jest.spyOn(Logger.prototype, m as any).mockImplementation(() => undefined));
    emitted.length = 0;
    savedUserSegments = [];
    savedMessages = [];
    mockConnect.mockReset();
    ({ socket, handlers } = fakeSocket());
    mockConnect.mockResolvedValue(socket);

    const deepgram = new DeepgramService({ get: jest.fn().mockReturnValue('fake-key') } as unknown as ConfigService);
    deepgram.onModuleInit();

    const conversationService = {
      assertOwnership: jest.fn(), getConversationFieldId: jest.fn().mockResolvedValue(null),
      findRecentEmptyConversation: jest.fn().mockResolvedValue(null), createConversation: jest.fn().mockResolvedValue({ id: 'conv-soak' }),
      getConversationParticipants: jest.fn().mockResolvedValue([]), upsertConversationParticipant: jest.fn().mockResolvedValue(undefined),
      getFullDocumentContext: jest.fn().mockResolvedValue(null),
      setTitle: jest.fn().mockResolvedValue(false),
      saveMessage: jest.fn(async (m: any) => { savedMessages.push({ role: m.role }); return {}; }),
      saveMessageWithTranscriptSegments: jest.fn(async (m: any, segs: any[]) => {
        savedMessages.push({ role: m.role });
        savedUserSegments.push(...segs.map((s) => ({ text: s.transcript, speakerId: s.deepgramSpeakerId, startMs: s.startMs })));
        return {};
      }),
    };
    const claudeService = {
      buildDualSpeakerPrompt: jest.fn().mockReturnValue('SYSTEM'),
      generateConversationTitle: jest.fn().mockResolvedValue('t'),
      streamResponse: jest.fn(async (_m: string, _h: unknown, _s: string, cb: any) => { await cb.onDone('ok', 1, 1); }),
    };
    const noop = {} as any;
    gateway = new VoiceGateway(
      deepgram as any, claudeService as any, conversationService as any, noop, noop, noop,
      { findById: jest.fn().mockResolvedValue({ name: 'Tolu', ai_memory: null, voice_speaker_id: null }) } as any,
      { resolveAuthorizedField: jest.fn().mockResolvedValue(null), findFieldRecordForUser: jest.fn(), getUserPrimaryField: jest.fn().mockResolvedValue(null) } as any,
      noop, { log: jest.fn() } as any, { verify: jest.fn().mockReturnValue({ sub: 'u1' }) } as any, { get: jest.fn().mockReturnValue('secret') } as any,
      noop, noop, noop,
      { getUserEntitlements: jest.fn().mockResolvedValue({ tier: 'xpress', entitlements: { allowedVoiceModes: ['single', 'multiple_speaker'], maxVoiceMinutesPerMonth: null, maxMessagesPerMonth: 1_000_000 } }) } as any,
      { getStatus: jest.fn().mockResolvedValue({ canUse: true }), tryConsume: jest.fn().mockResolvedValue(undefined) } as any,
      { getEffectiveLanguage: jest.fn().mockResolvedValue('en') } as any,
    );
    client = { id: 'sock-soak', emit: jest.fn((event: string, payload?: unknown) => { emitted.push([event, payload]); }) };
    await gateway.handleSessionStart(client, { accessToken: 'jwt', mode: 'multiple_speaker', clientSessionId: 'client-soak' });
    session = gateway.sessions.get(client.id);
  });

  afterEach(() => {
    try { session?.closeDeepgram?.(); } catch { /* already closed */ }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const count = (event: string) => emitted.filter(([e]) => e === event).length;

  /** One ~20-second "utterance": three speakers, 12+ words, then provider UtteranceEnd. */
  const speakUtterance = (n: number) => {
    const words = Array.from({ length: 12 }, (_, i) => ({
      word: `u${n}w${i}`,
      speaker: Math.floor(i / 4) % SPEAKERS,
      start: n * 20 + i * 0.3, // global, strictly increasing seconds → startMs orders every turn
      end: n * 20 + i * 0.3 + 0.25,
    }));
    handlers['message']({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: words.map((w) => w.word).join(' '), confidence: 0.92, words }] } });
    handlers['message']({ type: 'UtteranceEnd' });
  };

  const runFor = async (minutes: number, startedAtChunk: number, startedAtUtterance: number) => {
    let chunk = startedAtChunk;
    let utterance = startedAtUtterance;
    const chunksPerUtterance = 20_000 / CHUNK_MS;
    const total = (minutes * MINUTE) / CHUNK_MS;
    for (let i = 0; i < total; i++) {
      gateway.handleAudioChunk(client, { chunk: Buffer.alloc(8, chunk & 0xff), sequence: chunk, recordingId: 'rec-soak' });
      chunk++;
      if (chunk % chunksPerUtterance === 0) { speakUtterance(utterance); utterance++; }
      await jest.advanceTimersByTimeAsync(CHUNK_MS);
    }
    return { chunk, utterance };
  };

  it('stays healthy beyond 20 minutes (to 62 min): no cutoff, every chunk acked and delivered, keepalives continue, memory bounded, all turns persisted in order', async () => {
    gateway.handleStreamStart(client, { recordingId: 'rec-soak', streamEpoch: 1 });
    const { chunk, utterance } = await runFor(62, 0, 0);

    // ── no application-added time cutoff ──
    expect(gateway.sessions.has(client.id)).toBe(true);
    for (const terminal of ['session:ended', 'session:degraded', 'session:recovering', 'audio:continuity_warning']) expect(count(terminal)).toBe(0);
    expect(session.providerState).toBe('active');
    expect(session.providerEpoch).toBe(0);

    // ── chunks, acks and provider delivery ──
    expect(count('audio:ack')).toBe(chunk);
    expect(socket.sendMedia).toHaveBeenCalledTimes(chunk);
    expect(session.lastAckedSequence).toBe(chunk - 1);
    // ── provider keepalives kept flowing the whole time (every 6s for 62 min ≈ 620) ──
    expect(socket.sendKeepAlive.mock.calls.length).toBeGreaterThanOrEqual(600);
    expect(socket.sendKeepAlive.mock.calls.length).toBeLessThanOrEqual(625);

    // ── every accepted turn reached persistence, in order, across three speakers ──
    await gateway.drainSessionTurns(client, session, 'session_end');
    const spoken = utterance * 12;
    expect(savedUserSegments.reduce((n, s) => n + s.text.split(' ').length, 0)).toBe(spoken);
    const ordered = savedUserSegments.map((s) => s.startMs as number);
    expect([...ordered].sort((a, b) => a - b)).toEqual(ordered); // persisted order == spoken order
    expect(new Set(savedUserSegments.map((s) => s.speakerId))).toEqual(new Set([0, 1, 2]));
    expect(savedMessages.filter((m) => m.role === 'user').length).toBeGreaterThan(50);

    // ── memory stayed inside the documented bounds ──
    const hw = session.metrics.highWater;
    expect(hw.multiHistoryTurns).toBeLessThanOrEqual(SESSION_BOUNDS.MAX_MULTI_HISTORY_TURNS + 3);
    expect(hw.pendingTurns).toBeLessThanOrEqual(SESSION_BOUNDS.MAX_PENDING_TURNS + 3);
    expect(hw.confidenceSamples).toBeLessThanOrEqual(SESSION_BOUNDS.MAX_CONFIDENCE_SAMPLES + 1);
    expect(hw.recoveryBufferBytes).toBe(0);
    expect(hw.inFlightTurns).toBeLessThanOrEqual(1);
    expect(session.multiSpeakerHistory.length).toBeLessThanOrEqual(SESSION_BOUNDS.MAX_MULTI_HISTORY_TURNS);
    expect(session.acceptedTurnSeq).toBe(session.settledTurnSeq);

    if (process.env.SOAK_REPORT) {
      fs.writeFileSync(process.env.SOAK_REPORT, JSON.stringify({
        simulatedMinutes: 62,
        chunksSent: chunk,
        chunksAcked: count('audio:ack'),
        chunksDeliveredToProvider: socket.sendMedia.mock.calls.length,
        providerKeepAlives: socket.sendKeepAlive.mock.calls.length,
        utterances: utterance,
        wordsSpoken: spoken,
        wordsPersisted: savedUserSegments.reduce((n, s) => n + s.text.split(' ').length, 0),
        userMessagesPersisted: savedMessages.filter((m) => m.role === 'user').length,
        aiTurnsAcceptedSettled: [session.acceptedTurnSeq, session.settledTurnSeq],
        retainedHistoryTurns: session.multiSpeakerHistory.length,
        trimmedHistoryTurns: session.metrics.trimmedHistoryTurns,
        highWater: session.metrics.highWater,
        boundHits: session.metrics.boundHits,
        bounds: SESSION_BOUNDS,
        terminalEvents: ['session:ended', 'session:degraded'].map((e) => [e, count(e)]),
      }, null, 2));
    }
  }, 120_000);

  it('idle policy is separate: provider KeepAlives keep flowing for 30 minutes of silence, but only incoming audio counts as activity — the session then ends with idle_timeout', async () => {
    gateway.handleStreamStart(client, { recordingId: 'rec-soak', streamEpoch: 1 });
    await runFor(25, 0, 0); // 25 minutes of healthy audio
    expect(count('session:ended')).toBe(0);

    const keepAlivesBefore = socket.sendKeepAlive.mock.calls.length;
    await jest.advanceTimersByTimeAsync(29 * MINUTE); // silence, just under the policy
    expect(count('session:ended')).toBe(0);
    expect(socket.sendKeepAlive.mock.calls.length - keepAlivesBefore).toBeGreaterThanOrEqual(285); // ~29min/6s: KeepAlives are not activity

    await jest.advanceTimersByTimeAsync(2 * MINUTE);
    const ended = emitted.find(([e]) => e === 'session:ended');
    expect(ended?.[1]).toMatchObject({ reason: 'idle_timeout', correlation: { traceId: expect.any(String) } });
    expect(gateway.sessions.has(client.id)).toBe(false);
    // teardown stopped the provider KeepAlive timer too
    const after = socket.sendKeepAlive.mock.calls.length;
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(socket.sendKeepAlive.mock.calls.length).toBe(after);
  }, 120_000);

  it('a single audio chunk just inside the idle window resets it (the policy is inactivity, not total duration)', async () => {
    gateway.handleStreamStart(client, { recordingId: 'rec-soak', streamEpoch: 1 });
    let seq = 0;
    for (let i = 0; i < 6; i++) {
      gateway.handleAudioChunk(client, { chunk: Buffer.alloc(8), sequence: seq++, recordingId: 'rec-soak' });
      await jest.advanceTimersByTimeAsync(29 * MINUTE + 50_000);
    }
    expect(count('session:ended')).toBe(0); // ~3 hours, never idle for 30 minutes
    expect(gateway.sessions.has(client.id)).toBe(true);
  }, 120_000);
});
