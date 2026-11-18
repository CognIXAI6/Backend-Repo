/**
 * Integration evidence (real Postgres): the structured per-session report data survives a round trip through
 * conversation_summary_parts.session_data, parts written without it (older rows) still load, and the new
 * column is additive and nullable. Skipped unless TIMING_IT_DB_PORT is set.
 */
import knexFactory, { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
import { ConversationService } from './services/conversation.service';
import { buildSummaryReport } from './utils/summary-report.util';

const enabled = !!process.env.TIMING_IT_DB_PORT;
const d = enabled ? describe : describe.skip;

d('summary part session_data (real Postgres)', () => {
  let knex: Knex;
  let conversations: ConversationService;
  let userId: string;
  let conversationId: string;
  let m1: string;
  let m2: string;

  beforeAll(async () => {
    knex = knexFactory({
      client: 'pg',
      connection: { host: '127.0.0.1', port: Number(process.env.TIMING_IT_DB_PORT), user: 'postgres', password: 'x', database: process.env.TIMING_IT_DB_NAME ?? 'cognix_test' },
    });
    conversations = new ConversationService(knex, { get: jest.fn() } as unknown as ConfigService);
    [{ id: userId }] = await knex('users').insert({ email: `sd-${Date.now()}@example.com` }).returning('id');
    [{ id: conversationId }] = await knex('conversations').insert({ user_id: userId, total_messages: 2, last_activity_at: new Date() }).returning('id');
    const rows = await knex('conversation_messages')
      .insert([
        { conversation_id: conversationId, role: 'user', content: 'a', created_at: new Date(Date.UTC(2026, 10, 17, 9)) },
        { conversation_id: conversationId, role: 'user', content: 'b', created_at: new Date(Date.UTC(2026, 10, 18, 9)) },
      ])
      .returning('id');
    [m1, m2] = rows.map((r: { id: string }) => r.id);
  });
  afterAll(async () => {
    await knex('users').where('id', userId).delete();
    await knex.destroy();
  });

  it('stores and returns structured session data, alongside a legacy part without it, oldest first', async () => {
    const data = {
      version: 1 as const,
      summary: 'Reviewed Q4.',
      transcript: [
        { kind: 'turn' as const, speaker: 'Mr Tolu', text: 'hello — “quoted” Ẹ kú' },
        { kind: 'insights' as const, bullets: ['Ask about budget'] },
      ],
      keyInsights: ['One'],
      actionPoints: ['Send deck'],
    };
    await conversations.addSummaryPart(conversationId, userId, { title: 'Yesterday', topic: 'T1', sections: [{ heading: 'Summary', content: 'Old.' }] }, m1, m1);
    await conversations.addSummaryPart(conversationId, userId, { title: 'Today', topic: 'T2', sections: [{ heading: 'Summary', content: 'Reviewed Q4.' }] }, m2, m2, data);

    const parts = await conversations.getSummaryParts(conversationId, userId);
    expect(parts).toHaveLength(2);
    expect(parts[0].session_data ?? null).toBeNull();
    expect(parts[1].session_data).toEqual(data);

    const report = buildSummaryReport(parts as any, 'Conv');
    expect(report.sessions.map((s) => [s.number, s.title, s.summary])).toEqual([
      [1, 'Yesterday', 'Old.'],
      [2, 'Today', 'Reviewed Q4.'],
    ]);
    expect(report.sessions[1].transcript).toEqual(data.transcript);
  });

  it('is scoped to the owner: another user cannot read the parts', async () => {
    const [{ id: other }] = await knex('users').insert({ email: `sd2-${Date.now()}@example.com` }).returning('id');
    try {
      expect(await conversations.getSummaryParts(conversationId, other)).toEqual([]);
    } finally {
      await knex('users').where('id', other).delete();
    }
  });

  it('the column is nullable jsonb (additive migration)', async () => {
    const col = await knex('information_schema.columns').where({ table_name: 'conversation_summary_parts', column_name: 'session_data' }).first();
    expect(col.data_type).toBe('jsonb');
    expect(col.is_nullable).toBe('YES');
  });
});
