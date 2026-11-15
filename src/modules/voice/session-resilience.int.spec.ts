/**
 * Integration evidence (real Postgres + real ConversationService + the real
 * gateway code paths). Skipped unless TIMING_IT_DB_PORT is set — see
 * recording-timing.service.int.spec.ts.
 *
 *  1. Client outage longer than the 90 s summary grace → the deferred summary is
 *     already generating when the client resumes; a Stop during it must still end
 *     with a complete summary of the newer turns (nothing stranded behind the old claim).
 *  2. Long multi-speaker session: in-memory state stays bounded while the persisted
 *     transcript is complete and in spoken order.
 */
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import knexFactory, { Knex } from 'knex';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VoiceGateway } from './voice.gateway';
import { ConversationService } from './services/conversation.service';
import { SESSION_BOUNDS } from './utils/session-metrics.util';

const enabled = !!process.env.TIMING_IT_DB_PORT;
const d = enabled ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(5);
  }
}

d('session resilience (real Postgres)', () => {
  let knex: Knex;
  let conversations: ConversationService;
  let userId: string;

  beforeAll(async () => {
    knex = knexFactory({
      client: 'pg',
      connection: { host: '127.0.0.1', port: Number(process.env.TIMING_IT_DB_PORT), user: 'postgres', password: 'x', database: process.env.TIMING_IT_DB_NAME ?? 'cognix_test' },
    });
    conversations = new ConversationService(knex, { get: jest.fn() } as unknown as ConfigService);
    [{ id: userId }] = await knex('users').insert({ email: `res-${Date.now()}@example.com` }).returning('id');
  });
  afterAll(async () => {
    await knex('users').where('id', userId).delete();
    await knex.destroy();
  });
  beforeEach(() => {
    ['log', 'warn', 'error', 'debug'].forEach((m) => jest.spyOn(Logger.prototype, m as any).mockImplementation(() => undefined));
  });
  afterEach(() => jest.restoreAllMocks());

  const newConversation = async () => (await knex('conversations').insert({ user_id: userId }).returning('id'))[0].id as string;
  const addMessage = async (cid: string, content: string, minutes: number, role = 'user') =>
    (await knex('conversation_messages').insert({
      conversation_id: cid, role, content, created_at: new Date(Date.UTC(2026, 10, 10, 9, minutes)),
    }).returning('id'))[0].id as string;
  const newDoc = async () => (await knex('generated_documents').insert({ user_id: userId, title: 'doc', download_url: 'https://example.com/d' }).returning('id'))[0].id as string;

  const baseSession = (over: Record<string, unknown>) => ({
    userId, isGuest: false, mode: 'multiple_speaker', isMultiSpeaker: true, isDualSpeaker: false,
    fieldName: undefined, cachedOwnerName: 'Tolu', otherSpeakerName: null, recordingSessionId: randomUUID(), providerEpoch: 0,
    providerState: 'active', inFlightTurns: new Set(), acceptedTurnSeq: 0, settledTurnSeq: 0,
    pendingMultiSpeakerTurns: [], multiSpeakerHistory: [], dualSpeakerHistory: [], transcriptConfidences: [],
    pendingOwnerText: '', pendingOtherText: '', pendingUnattributedText: '', accumulatedTranscript: '',
    resolvedSpeakers: new Map(), anonymousSpeakerLabels: new Map(), nextAnonymousSpeakerNumber: 1,
    speakerAudioBuffers: new Map(), speakerAudioBytes: new Map(), speakerWordSeconds: new Map(),
    speakerIdentificationTriggered: new Set(), speakerIdentificationFailed: new Set(), speakerIdentificationAtSeconds: new Map(),
    identifiedDeepgramSpeakers: new Map(), speakerRoster: [], speakerRosterByVoiceId: new Map(),
    currentDominantSpeaker: 0, audioBuffer: [], audioBufferBytes: 0, streamSequences: new Map(),
    recoveryAudioBuffer: [], recoveryAudioBufferBytes: 0, recoveryBufferOverflowStartedAt: null, recoveryDroppedBytes: 0,
    deepgramEmitter: new EventEmitter(), sendAudio: jest.fn().mockReturnValue(true), closeDeepgram: jest.fn(), sendFinalize: jest.fn().mockReturnValue(true),
    utteranceDebounceMs: 0, utteranceDebounceTimer: null, idleTimeoutHandle: null, activeStreamId: null, lastAckedSequence: null, lastAckedStreamId: null,
    traceId: 'trace-int', metrics: undefined as unknown, ...over,
  });

  describe('outage longer than the 90 s summary grace, resume while the summary is pending, then Stop', () => {
    it('the newer turns get a subsequent complete summary — nothing is stranded behind the old claim', async () => {
      const cid = await newConversation();
      const [m1, m2, m3] = [await addMessage(cid, 'we discussed the Q3 budget', 0), await addMessage(cid, 'ai reply one', 1, 'assistant'), await addMessage(cid, 'and the hiring plan', 2)];
      const docA = await newDoc();
      const docB = await newDoc();

      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const summarised: string[][] = [];
      const claude = {
        generateConversationSummaryDocument: jest.fn(async (history: Array<{ content: string }>) => {
          summarised.push(history.map((h) => h.content));
          if (summarised.length === 1) await gate;
          return { title: summarised.length === 1 ? 'Part A' : 'Part B', topic: 't', sections: [{ heading: 'Summary', content: 'S' }] };
        }),
      };
      const docs = [docA, docB];
      const documentService = {
        generateAndUpload: jest.fn(async () => ({ docId: docs.shift(), downloadUrl: 'https://example.com/d' })),
        buildSummaryPdfBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      };
      const noop = {} as any;
      const gateway: any = new VoiceGateway(
        noop, claude as any, conversations, noop, noop, noop, { findById: jest.fn().mockResolvedValue({ id: userId, email: 'owner@example.com' }) } as any,
        noop, { sendConversationSummaryEmail: jest.fn().mockResolvedValue(undefined) } as any, { log: jest.fn() } as any,
        noop, noop, noop, documentService as any, { sendToUser: jest.fn().mockResolvedValue(undefined) } as any, noop,
        { getStatus: jest.fn().mockResolvedValue({ canUse: true }), tryConsume: jest.fn().mockResolvedValue(undefined) } as any, noop,
      );
      gateway.DISCONNECT_SUMMARY_GRACE_MS = 40; // stands in for the 90 s grace
      const entitlements = { maxDocumentsPerMonth: 10, allowedDocumentDepths: ['brief'] };

      // 1) the phone drops; the outage outlasts the grace, so the deferred summary starts generating
      const client1: any = { id: 'sock-1', emit: jest.fn() };
      gateway.sessions.set(client1.id, baseSession({ conversationId: cid, entitlements }));
      await gateway.handleDisconnect(client1);
      await until(() => claude.generateConversationSummaryDocument.mock.calls.length === 1, 'first (deferred) summary to start generating');
      expect((await knex('conversations').where('id', cid).first()).summary_status).toBe('pending');

      // 2) the client resumes inside its recovery budget and says two more things
      const m4 = await addMessage(cid, 'new topic: the office move', 10);
      const m5 = await addMessage(cid, 'ai reply two', 11, 'assistant');

      // 3) ...then presses Stop while the old summary is still being generated
      const client2: any = { id: 'sock-2', emit: jest.fn() };
      gateway.sessions.set(client2.id, baseSession({ conversationId: cid, entitlements, recordingSessionId: randomUUID() }));
      await gateway.handleSessionEnd(client2);
      expect(claude.generateConversationSummaryDocument).toHaveBeenCalledTimes(1); // no second claim yet: it is queued, not dropped
      expect(gateway.summaryRerunRequests.has(cid)).toBe(true);

      // 4) the old generation finishes; the follow-up runs for the newer turns
      release();
      await until(() => gateway.summariesInFlight.size === 0 && gateway.summaryRerunRequests.size === 0, 'follow-up summary to finish');
      await until(async () => (await knex('conversations').where('id', cid).first()).summary_status === 'ready', 'status ready');

      expect(summarised).toEqual([
        ['we discussed the Q3 budget', 'ai reply one', 'and the hiring plan'],
        ['new topic: the office move', 'ai reply two'],
      ]);
      const parts = await knex('conversation_summary_parts').where('conversation_id', cid).orderBy('covers_from');
      expect(parts.map((p: any) => p.title)).toEqual(['Part A', 'Part B']);
      const range = async (a: string, b: string) => (await knex.raw('SELECT (SELECT created_at FROM conversation_messages WHERE id = ?) AS f, (SELECT created_at FROM conversation_messages WHERE id = ?) AS t', [a, b])).rows[0];
      expect(new Date(parts[0].covers_from).getTime()).toBe(new Date((await range(m1, m3)).f).getTime());
      expect(new Date(parts[0].covers_to).getTime()).toBe(new Date((await range(m1, m3)).t).getTime());
      expect(new Date(parts[1].covers_from).getTime()).toBe(new Date((await range(m4, m5)).f).getTime());
      expect(documentService.generateAndUpload).toHaveBeenCalledTimes(2);

      // a further Stop with nothing new is a no-op: up to date, no duplicate part
      gateway.sessions.set('sock-3', baseSession({ conversationId: cid, entitlements }));
      await gateway.autoGenerateConversationSummary({ id: 'sock-3', emit: jest.fn() }, gateway.sessions.get('sock-3'));
      expect(await knex('conversation_summary_parts').where('conversation_id', cid)).toHaveLength(2);
      expect((await knex('conversations').where('id', cid).first()).summary_status).toBe('ready');
    }, 30_000);
  });

  describe('long multi-speaker session', () => {
    it('keeps in-memory state bounded while the persisted transcript is complete and in spoken order', async () => {
      const cid = await newConversation();
      const claude = {
        buildDualSpeakerPrompt: jest.fn().mockReturnValue('SYSTEM'),
        generateConversationTitle: jest.fn().mockResolvedValue('t'),
        streamResponse: jest.fn(async (_m: string, _h: unknown, _s: string, cb: any) => { await cb.onDone('ok', 1, 1); }),
      };
      const noop = {} as any;
      const gateway: any = new VoiceGateway(
        noop, claude as any, conversations, noop, noop, noop, noop, noop, noop, { log: jest.fn() } as any,
        noop, noop, noop, noop, noop, noop, noop, { getEffectiveLanguage: jest.fn().mockResolvedValue('en') } as any,
      );
      const { createSessionMetrics } = await import('./utils/session-metrics.util');
      const session: any = baseSession({ conversationId: cid, isGuest: true, metrics: createSessionMetrics() });
      const client: any = { id: 'sock-long', emit: jest.fn() };
      gateway.sessions.set(client.id, session);
      gateway.attachDeepgramListeners(client, session, session.deepgramEmitter);

      const TOTAL = 1_200;
      const expected: string[] = [];
      for (let i = 0; i < TOTAL; i++) {
        const words = Array.from({ length: 3 }, (_, w) => ({ word: `t${i}w${w}`, speaker: i % 3, start: i * 2 + w * 0.3, end: i * 2 + w * 0.3 + 0.25 }));
        expected.push(words.map((w) => w.word).join(' '));
        session.deepgramEmitter.emit('transcript', { isFinal: true, transcript: expected[i], confidence: 0.9, words });
        if (i % 25 === 0) await sleep(2); // paced like real speech: the DB keeps up
      }
      await gateway.drainSessionTurns(client, session, 'session_end');

      const rows = await knex('conversation_transcript_segments as s')
        .join('conversation_messages as m', 's.message_id', 'm.id')
        .where('s.conversation_id', cid)
        .orderBy([{ column: 'm.created_at' }, { column: 's.start_ms' }])
        .select('s.transcript', 's.deepgram_speaker_id');
      expect(rows.map((r: any) => r.transcript)).toEqual(expected); // none lost, none duplicated, spoken order
      expect(new Set(rows.map((r: any) => r.deepgram_speaker_id))).toEqual(new Set([0, 1, 2]));

      expect(session.multiSpeakerHistory.length).toBeLessThanOrEqual(SESSION_BOUNDS.MAX_MULTI_HISTORY_TURNS);
      expect(session.metrics.highWater.multiHistoryTurns).toBeLessThanOrEqual(SESSION_BOUNDS.MAX_MULTI_HISTORY_TURNS + 3);
      expect(session.metrics.trimmedHistoryTurns).toBe(TOTAL - session.multiSpeakerHistory.length);
      expect(session.pendingMultiSpeakerTurns).toHaveLength(0);
      expect(session.inFlightTurns.size).toBe(0);
      expect(session.acceptedTurnSeq).toBe(session.settledTurnSeq);
    }, 60_000);
  });
});
