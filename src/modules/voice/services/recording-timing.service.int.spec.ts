/**
 * Integration tests against a REAL Postgres (the SQL is the point: grouped
 * aggregates, row locks, cascade). Skipped unless TIMING_IT_DB_PORT is set,
 * pointing at a database with all migrations applied, e.g.
 *   TIMING_IT_DB_PORT=54329 TIMING_IT_DB_NAME=cognix_test npx jest recording-timing.service.int
 */
import knexFactory, { Knex } from 'knex';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecordingTimingService, fetchTimingDetail, fetchTimingSummaries } from './recording-timing.service';
import { ConversationService } from './conversation.service';

const enabled = !!process.env.TIMING_IT_DB_PORT;
const d = enabled ? describe : describe.skip;

d('RecordingTimingService (real Postgres)', () => {
  let knex: Knex;
  let svc: RecordingTimingService;
  let conversations: ConversationService;
  let userId: string;
  let otherUserId: string;

  const newConversation = async (uid = userId) => {
    const [c] = await knex('conversations').insert({ user_id: uid, total_messages: 0 }).returning('*');
    return c.id as string;
  };
  const addMessage = (conversationId: string, createdAt?: Date) =>
    knex('conversation_messages').insert({
      conversation_id: conversationId, role: 'user', content: 'hi', ...(createdAt ? { created_at: createdAt } : {}),
    });
  const detail = async (id: string) => {
    const row = await knex('conversations').where('id', id).first();
    return fetchTimingDetail(knex, row);
  };
  const sess = async (cid: string, sid: string, sock = 's1', uid = userId) =>
    svc.startSession({ userId: uid, conversationId: cid, clientSessionId: sid, socketId: sock });

  beforeAll(async () => {
    knex = knexFactory({
      client: 'pg',
      connection: {
        host: '127.0.0.1', port: Number(process.env.TIMING_IT_DB_PORT), user: 'postgres', password: 'x',
        database: process.env.TIMING_IT_DB_NAME ?? 'cognix_test',
      },
    });
    svc = new RecordingTimingService(knex);
    conversations = new ConversationService(knex, { get: jest.fn() } as unknown as ConfigService);
    const tag = Date.now();
    [{ id: userId }] = await knex('users').insert({ email: `t1-${tag}@example.com` }).returning('id');
    [{ id: otherUserId }] = await knex('users').insert({ email: `t2-${tag}@example.com` }).returning('id');
  });
  afterAll(async () => {
    await knex('users').whereIn('id', [userId, otherUserId]).delete();
    await knex.destroy();
  });

  it('legacy conversation with messages and no sessions → unknown, null total, bounds present', async () => {
    const c = await newConversation();
    await addMessage(c, new Date('2026-11-11T10:00:00Z'));
    await addMessage(c, new Date('2026-11-11T12:50:00Z'));
    const { timing, messageDateBounds } = await detail(c);
    expect(timing).toMatchObject({ completeness: 'unknown', recordedDurationMs: null, sessionCount: 0, sessions: [] });
    expect(messageDateBounds).toMatchObject({ source: 'message_created_at', coverage: 'complete' });
    expect(messageDateBounds.firstMessageAt).toBe('2026-11-11T10:00:00.000Z');
    expect(messageDateBounds.lastMessageAt).toBe('2026-11-11T12:50:00.000Z');
  });

  it('legacy conversation + new measured session → partial; estimate never added to the total or turned into a session', async () => {
    const c = await newConversation();
    await addMessage(c, new Date('2026-11-11T10:00:00Z'));
    await addMessage(c, new Date('2026-11-11T12:50:00Z'));
    await sess(c, 'logical-2');
    await svc.applyReport({ userId, conversationId: c, clientSessionId: 'logical-2', report: { seq: 1, intervals: [{ startMs: 0, endMs: 100 }], final: true } });
    const { timing, messageDateBounds } = await detail(c);
    expect(timing).toMatchObject({ sessionCount: 1, completeness: 'partial', sessionsCoverage: 'complete' });
    expect((timing.sessions as any[])).toHaveLength(1);
    expect((timing.recordedDurationMs as number)).toBeLessThanOrEqual(10_100); // nowhere near the 2h50m span
    expect(messageDateBounds.firstMessageAt).toBe('2026-11-11T10:00:00.000Z');
  });

  it('a failed start (wrong owner / unknown conversation) creates no session row and no revision bump', async () => {
    const c = await newConversation();
    expect(await sess(c, 'x1', 's1', otherUserId)).toBeNull();
    expect(await svc.startSession({ userId, conversationId: '00000000-0000-0000-0000-000000000000', clientSessionId: 'x2', socketId: 's' })).toBeNull();
    expect((await knex('conversation_recording_sessions').where('conversation_id', c)).length).toBe(0);
    expect((await knex('conversations').where('id', c).first()).timing_revision).toBe(0);
  });

  it('start is idempotent; a reconnect resumes the same logical session instead of creating a new one', async () => {
    const c = await newConversation();
    expect(await sess(c, 'a', 's1')).toEqual({ created: true, status: 'active' });
    expect(await sess(c, 'a', 's1')).toEqual({ created: false, status: 'active' });
    await svc.closeBySocket({ conversationId: c, socketId: 's1', status: 'interrupted' });
    expect((await detail(c)).timing.sessions as any[]).toMatchObject([{ id: 'a', status: 'interrupted', completeness: 'partial' }]);
    expect(await sess(c, 'a', 's2')).toEqual({ created: false, status: 'active' });
    const t = (await detail(c)).timing;
    expect(t.sessionCount).toBe(1);
    expect((t.sessions as any[])[0].status).toBe('active');
  });

  it('a stale socket cannot close a session a newer socket resumed', async () => {
    const c = await newConversation();
    await sess(c, 'a', 's1');
    await sess(c, 'a', 's2'); // resumed on a new socket
    await svc.closeBySocket({ conversationId: c, socketId: 's1', status: 'interrupted' }); // late disconnect of the old socket
    expect(((await detail(c)).timing.sessions as any[])[0].status).toBe('active');
  });

  it('duplicate, stale and reordered reports are ignored; overlap is unioned; replay cannot inflate capture', async () => {
    const c = await newConversation();
    await sess(c, 'a');
    const rep = (seq: number, intervals: any[], final = false) =>
      svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq, intervals, final } });
    expect(await rep(2, [{ startMs: 0, endMs: 3000 }])).toMatchObject({ applied: true });
    expect(await rep(2, [{ startMs: 0, endMs: 3000 }])).toMatchObject({ applied: false }); // duplicate
    expect(await rep(1, [{ startMs: 0, endMs: 9999 }])).toMatchObject({ applied: false }); // stale
    expect(await rep(3, [{ startMs: 2000, endMs: 5000 }, { startMs: 0, endMs: 3000 }])).toMatchObject({ applied: true }); // overlap
    const row = await knex('conversation_recording_sessions').where('conversation_id', c).first();
    expect(row.captured_ms).toBe(5000);
    // claiming more than wall-clock allows is clamped (+10s tolerance)
    await rep(4, [{ startMs: 0, endMs: 9_000_000 }]);
    expect((await knex('conversation_recording_sessions').where('conversation_id', c).first()).captured_ms).toBeLessThan(12_000);
    // non-integer seq rejected
    expect(await rep(1.5 as number, [])).toMatchObject({ applied: false });
  });

  it('a final report completes the session; later reports are ignored; aggregate is complete when nothing predates it', async () => {
    const c = await newConversation();
    await sess(c, 'a');
    await addMessage(c); // after session start
    await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 1, intervals: [{ startMs: 0, endMs: 50 }], final: true } });
    expect(await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 2, intervals: [{ startMs: 0, endMs: 9000 }] } })).toMatchObject({ applied: false });
    const { timing } = await detail(c);
    expect(timing).toMatchObject({ completeness: 'complete', recordedDurationMs: 50 });
    expect((timing.sessions as any[])[0]).toMatchObject({ status: 'ended', completeness: 'complete' });
    expect((timing.sessions as any[])[0].elapsedDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('session:end without a final report is ended but partial; a late final report upgrades it', async () => {
    const c = await newConversation();
    await sess(c, 'a', 's1');
    await svc.closeBySocket({ conversationId: c, socketId: 's1', status: 'ended' });
    expect(((await detail(c)).timing.sessions as any[])[0]).toMatchObject({ status: 'ended', completeness: 'partial' });
    await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 1, intervals: [], final: true } });
    expect(((await detail(c)).timing.sessions as any[])[0]).toMatchObject({ status: 'ended', completeness: 'complete' });
  });

  it('repeated sessions in one conversation are preserved and summed', async () => {
    const c = await newConversation();
    for (const [sid, end] of [['s-1', 40], ['s-2', 60]] as const) {
      await sess(c, sid);
      await svc.applyReport({ userId, conversationId: c, clientSessionId: sid, report: { seq: 1, intervals: [{ startMs: 0, endMs: end }], final: true } });
    }
    const { timing } = await detail(c);
    expect(timing).toMatchObject({ sessionCount: 2, recordedDurationMs: 100, completeness: 'complete' });
    expect((timing.sessions as any[]).map((s) => s.id)).toEqual(['s-1', 's-2']);
  });

  it('list and detail agree on aggregate and revision; list is a single grouped read', async () => {
    const c = await newConversation();
    await sess(c, 'a');
    await addMessage(c);
    const conv = await knex('conversations').where('id', c).first();
    const list = (await fetchTimingSummaries(knex, [conv])).get(c)!;
    const det = await fetchTimingDetail(knex, conv);
    const { sessions, sessionsCoverage, ...detAgg } = det.timing as any;
    expect(list.timing).toEqual(detAgg);
    expect(list.messageDateBounds).toEqual(det.messageDateBounds);
    expect(list.timing.revision).toBe(conv.timing_revision);
  });

  it('ConversationService.getHistory/getConversation expose timing additively and enforce ownership', async () => {
    const c = await newConversation();
    await addMessage(c);
    await knex('conversations').where('id', c).update({ total_messages: 1, last_activity_at: new Date() });
    await sess(c, 'a');
    const page = await conversations.getHistory(userId, 1, 50);
    const row: any = page.data.find((x: any) => x.id === c);
    expect(row.timing).toMatchObject({ version: 1, sessionCount: 1 });
    expect(row.messageDateBounds.firstMessageAt).toBeTruthy();
    const full: any = await conversations.getConversation(c, userId);
    expect(full.timing.sessions).toHaveLength(1);
    await expect(conversations.getConversation(c, otherUserId)).rejects.toBeInstanceOf(NotFoundException);
    // other user cannot report into or see this session
    expect(await svc.applyReport({ userId: otherUserId, conversationId: c, clientSessionId: 'a', report: { seq: 1, intervals: [] } })).toMatchObject({ applied: false });
  });

  it('detail reports partial session coverage when sessions exceed the page limit', async () => {
    const c = await newConversation();
    await knex('conversation_recording_sessions').insert(
      Array.from({ length: 201 }, (_, i) => ({
        conversation_id: c, user_id: userId, client_session_id: `bulk-${i}`, started_at: new Date(Date.now() + i * 1000),
      })),
    );
    const { timing } = await detail(c);
    expect(timing.sessionCount).toBe(201);
    expect((timing.sessions as any[]).length).toBe(200);
    expect(timing.sessionsCoverage).toBe('partial');
  });

  it('deleting a conversation cascades its session rows', async () => {
    const c = await newConversation();
    await sess(c, 'a');
    await knex('conversations').where('id', c).delete();
    expect((await knex('conversation_recording_sessions').where('conversation_id', c)).length).toBe(0);
  });

  describe('resume after a socket drop', () => {
    it('clears the provisional disconnect end, so the final report sets the true end and elapsed time', async () => {
      const c = await newConversation();
      await sess(c, 'a', 's1');
      // pretend the session started a minute ago
      await knex('conversation_recording_sessions').where('conversation_id', c).update({ started_at: new Date(Date.now() - 60_000) });
      await svc.closeBySocket({ conversationId: c, socketId: 's1', status: 'interrupted' });
      const dropped = await knex('conversation_recording_sessions').where('conversation_id', c).first();
      expect(dropped.ended_at).not.toBeNull(); // provisional: when the socket went away
      expect(dropped.status).toBe('interrupted');

      // resumed on a new socket after the outage
      await sess(c, 'a', 's2');
      const resumed = await knex('conversation_recording_sessions').where('conversation_id', c).first();
      expect([resumed.status, resumed.ended_at, resumed.elapsed_ms]).toEqual(['active', null, null]);

      // capture continued well past the provisional end; the final report closes it at the real boundary
      const result = await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 1, intervals: [{ startMs: 0, endMs: 55_000 }], final: true } });
      expect(result).toMatchObject({ applied: true, status: 'ended', completeness: 'complete' });
      const done = await knex('conversation_recording_sessions').where('conversation_id', c).first();
      expect(done.captured_ms).toBe(55_000);
      expect(done.elapsed_ms).toBeGreaterThanOrEqual(59_000); // true end (≈ now), not the earlier disconnect time
      expect(new Date(done.ended_at).getTime()).toBeGreaterThan(new Date(dropped.ended_at).getTime() - 1);
    });

    it('a still-active session resumed on a new socket keeps its (empty) end; an ended session is left untouched', async () => {
      const c = await newConversation();
      await sess(c, 'a', 's1');
      expect(await svc.startSession({ userId, conversationId: c, clientSessionId: 'a', socketId: 's2' })).toEqual({ created: false, status: 'active' });
      await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 1, intervals: [], final: true } });
      expect(await svc.startSession({ userId, conversationId: c, clientSessionId: 'a', socketId: 's3' })).toEqual({ created: false, status: 'ended' });
    });
  });

  describe('interval cap does not lose valid new capture', () => {
    it('500 stored intervals + a long new one: the new capture counts, and the result is partial rather than complete', async () => {
      const c = await newConversation();
      await sess(c, 'a');
      const stored = Array.from({ length: 500 }, (_, i) => ({ startMs: i * 1_100, endMs: i * 1_100 + 100 }));
      await knex('conversation_recording_sessions').where('conversation_id', c).update({
        started_at: new Date(Date.now() - 3_600_000), intervals: JSON.stringify(stored), captured_ms: 500 * 100, report_seq: 1,
      });
      const result = await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 2, intervals: [{ startMs: 1_000_000, endMs: 1_060_000 }], final: true } });
      expect(result).toMatchObject({ applied: true, status: 'ended', completeness: 'partial', reason: 'intervals_truncated' });
      const row = await knex('conversation_recording_sessions').where('conversation_id', c).first();
      expect(row.captured_ms).toBe(500 * 100 + 60_000 - 100); // the long interval is in; one 100ms interval was shed
      expect(row.completeness).toBe('partial'); // a lower bound is never reported as complete
      expect(row.intervals).toContainEqual({ startMs: 1_000_000, endMs: 1_060_000 });
    });

    it('a merge that stays under the cap is complete and unchanged in meaning', async () => {
      const c = await newConversation();
      await sess(c, 'a');
      const stored = Array.from({ length: 500 }, (_, i) => ({ startMs: i * 1_100, endMs: i * 1_100 + 100 }));
      await knex('conversation_recording_sessions').where('conversation_id', c).update({ started_at: new Date(Date.now() - 3_600_000), intervals: JSON.stringify(stored), captured_ms: 50_000, report_seq: 1 });
      const result = await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 2, intervals: [{ startMs: 50, endMs: 1_150 }], final: true } }); // bridges two
      expect(result).toMatchObject({ applied: true, completeness: 'complete' });
      expect(result.reason).toBeUndefined();
    });
  });

  describe('report results (acknowledgements)', () => {
    it('say why a report was not applied, with the session\'s current state, so a client can retry or stop', async () => {
      const c = await newConversation();
      await sess(c, 'a');
      expect(await svc.applyReport({ userId, conversationId: c, clientSessionId: 'nope', report: { seq: 1, intervals: [] } })).toEqual({ applied: false, reason: 'not_found' });
      expect(await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 0, intervals: [] } })).toEqual({ applied: false, reason: 'invalid_seq' });
      await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 2, intervals: [{ startMs: 0, endMs: 10 }] } });
      expect(await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 1, intervals: [] } })).toMatchObject({ applied: false, reason: 'stale', status: 'active', completeness: 'partial' });
      await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 3, intervals: [], final: true } });
      // a retried final report is a safe no-op that tells the client it is already complete
      expect(await svc.applyReport({ userId, conversationId: c, clientSessionId: 'a', report: { seq: 3, intervals: [], final: true } })).toEqual({ applied: false, reason: 'already_complete', status: 'ended', completeness: 'complete' });
    });
  });
});
