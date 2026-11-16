/**
 * Integration tests (real Postgres) for the summary-email outcome contract:
 * additive columns, legacy rows read as "unknown", ownership on reads, stale
 * attempts, and — through the real summary path — that an email failure never
 * changes summary readiness and nothing identifying is stored.
 * Skipped unless TIMING_IT_DB_PORT is set (see recording-timing.service.int.spec.ts).
 */
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import knexFactory, { Knex } from 'knex';
import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VoiceGateway } from './voice.gateway';
import { ConversationService } from './services/conversation.service';
import { SUMMARY_EMAIL_PENDING_STALE_MS } from './utils/summary-email-status.util';

const enabled = !!process.env.TIMING_IT_DB_PORT;
const d = enabled ? describe : describe.skip;
const ADDRESS = 'sentinel.owner@example.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(5);
  }
}

d('summary email outcome (real Postgres)', () => {
  let knex: Knex;
  let conversations: ConversationService;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    knex = knexFactory({
      client: 'pg',
      connection: { host: '127.0.0.1', port: Number(process.env.TIMING_IT_DB_PORT), user: 'postgres', password: 'x', database: process.env.TIMING_IT_DB_NAME ?? 'cognix_test' },
    });
    conversations = new ConversationService(knex, { get: jest.fn() } as unknown as ConfigService);
    const tag = Date.now();
    [{ id: userId }] = await knex('users').insert({ email: `se-a-${tag}@example.com` }).returning('id');
    [{ id: otherUserId }] = await knex('users').insert({ email: `se-b-${tag}@example.com` }).returning('id');
  });
  afterAll(async () => {
    await knex('users').whereIn('id', [userId, otherUserId]).delete();
    await knex.destroy();
  });
  beforeEach(() => ['log', 'warn', 'error', 'debug'].forEach((m) => jest.spyOn(Logger.prototype, m as any).mockImplementation(() => undefined)));
  afterEach(() => jest.restoreAllMocks());

  const newConversation = async (uid = userId) => (await knex('conversations').insert({ user_id: uid, total_messages: 1, last_activity_at: new Date() }).returning('id'))[0].id as string;
  const newDoc = async () => (await knex('generated_documents').insert({ user_id: userId, title: 'doc', download_url: 'https://example.com/d' }).returning('id'))[0].id as string;
  const emailOf = async (cid: string) => ((await conversations.getConversation(cid, userId)) as any).summaryEmail;

  describe('read contract', () => {
    it('a legacy conversation (columns NULL) reports status unknown — old rows keep working', async () => {
      const c = await newConversation();
      expect(await emailOf(c)).toEqual({ status: 'unknown', reason: null, updatedAt: null, documentId: null });
      const row = await knex('conversations').where('id', c).first();
      expect([row.summary_email_status, row.summary_email_reason, row.summary_email_updated_at, row.summary_email_document_id]).toEqual([null, null, null, null]);
    });

    it('detail and history list rows carry the same summaryEmail object; the pre-existing fields are unchanged', async () => {
      const c = await newConversation();
      const doc = await newDoc();
      await conversations.setSummaryEmailStatus(c, userId, { status: 'pending', documentId: doc });
      await conversations.setSummaryEmailStatus(c, userId, { status: 'accepted_by_provider', documentId: doc });
      const detail: any = await conversations.getConversation(c, userId);
      const list: any = (await conversations.getHistory(userId, 1, 50)).data.find((x: any) => x.id === c);
      expect(detail.summaryEmail).toMatchObject({ status: 'accepted_by_provider', reason: null, documentId: doc });
      expect(list.summaryEmail).toEqual(detail.summaryEmail);
      for (const field of ['id', 'title', 'summary_status', 'messages', 'timing']) expect(field in detail).toBe(true);
    });

    it('an abandoned pending attempt reads as unknown, not pending forever', async () => {
      const c = await newConversation();
      await conversations.setSummaryEmailStatus(c, userId, { status: 'pending', documentId: null });
      expect((await emailOf(c)).status).toBe('pending');
      await knex('conversations').where('id', c).update({ summary_email_updated_at: new Date(Date.now() - SUMMARY_EMAIL_PENDING_STALE_MS - 60_000) });
      expect(await emailOf(c)).toMatchObject({ status: 'unknown', reason: 'stale_pending' });
    });

    it('is only readable by the conversation owner', async () => {
      const c = await newConversation();
      await conversations.setSummaryEmailStatus(c, userId, { status: 'failed', reason: 'provider_rejected', documentId: null });
      await expect(conversations.getConversation(c, otherUserId)).rejects.toBeInstanceOf(NotFoundException);
      expect((await conversations.getHistory(otherUserId, 1, 50)).data.some((x: any) => x.id === c)).toBe(false);
    });
  });

  describe('write rules', () => {
    it('a slow older attempt cannot overwrite a newer attempt\'s outcome', async () => {
      const c = await newConversation();
      const [docOld, docNew] = [await newDoc(), await newDoc()];
      await conversations.setSummaryEmailStatus(c, userId, { status: 'pending', documentId: docOld });
      await conversations.setSummaryEmailStatus(c, userId, { status: 'pending', documentId: docNew }); // resumed conversation: a newer summary
      expect(await conversations.setSummaryEmailStatus(c, userId, { status: 'failed', reason: 'unknown_error', documentId: docOld })).toBe(false);
      expect(await emailOf(c)).toMatchObject({ status: 'pending', documentId: docNew });
      expect(await conversations.setSummaryEmailStatus(c, userId, { status: 'accepted_by_provider', documentId: docNew })).toBe(true);
      expect((await emailOf(c)).status).toBe('accepted_by_provider');
    });

    it('a skipped outcome (no recipient) starts a fresh attempt regardless of the previous one', async () => {
      const c = await newConversation();
      await conversations.setSummaryEmailStatus(c, userId, { status: 'accepted_by_provider', documentId: await newDoc() });
      expect(await conversations.setSummaryEmailStatus(c, userId, { status: 'skipped', reason: 'no_recipient', documentId: await newDoc() })).toBe(true);
      expect(await emailOf(c)).toMatchObject({ status: 'skipped', reason: 'no_recipient' });
    });
  });

  describe('through the real auto-summary path', () => {
    const run = async (emailBehaviour: 'accept' | { reject: any }) => {
      const cid = await newConversation();
      await knex('conversation_messages').insert([
        { conversation_id: cid, role: 'user', content: 'we reviewed the plan', created_at: new Date(Date.UTC(2026, 10, 10, 9, 0)) },
        { conversation_id: cid, role: 'assistant', content: 'noted', created_at: new Date(Date.UTC(2026, 10, 10, 9, 1)) },
      ]);
      const docId = await newDoc();
      const sendEmail = jest.fn(async () => { if (emailBehaviour !== 'accept') throw Object.assign(new Error(`Resend failed: Invalid recipient ${ADDRESS}`), emailBehaviour.reject); });
      const noop = {} as any;
      const gateway: any = new VoiceGateway(
        noop, { generateConversationSummaryDocument: jest.fn().mockResolvedValue({ title: 'T', topic: 't', sections: [{ heading: 'Summary', content: 'S' }] }) } as any,
        conversations, noop, noop, noop, { findById: jest.fn().mockResolvedValue({ id: userId, email: ADDRESS }) } as any,
        noop, { sendConversationSummaryEmail: sendEmail } as any, { log: jest.fn() } as any,
        noop, noop, noop,
        { generateAndUpload: jest.fn().mockResolvedValue({ docId, downloadUrl: 'https://example.com/d' }), buildSummaryPdfBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')) } as any,
        { sendToUser: jest.fn().mockResolvedValue(undefined) } as any, noop,
        { getStatus: jest.fn().mockResolvedValue({ canUse: true }), tryConsume: jest.fn().mockResolvedValue(undefined) } as any, noop,
      );
      const session: any = {
        userId, isGuest: false, conversationId: cid, traceId: 'trace-se', cachedOwnerName: 'Tolu', otherSpeakerName: null, isMultiSpeaker: false,
        entitlements: { maxDocumentsPerMonth: 10, allowedDocumentDepths: ['brief'] }, recordingSessionId: randomUUID(), providerEpoch: 0,
        inFlightTurns: new Set(), deepgramEmitter: new EventEmitter(),
      };
      await gateway.autoGenerateConversationSummary({ id: 'sock', emit: jest.fn() }, session);
      return { cid, sendEmail };
    };

    it('provider accepted: summary ready AND email accepted_by_provider; nothing identifying stored', async () => {
      const { cid } = await run('accept');
      await until(async () => (await emailOf(cid)).status === 'accepted_by_provider', 'email accepted');
      const row = await knex('conversations').where('id', cid).first();
      expect(row.summary_status).toBe('ready');
      expect(JSON.stringify(row)).not.toContain(ADDRESS);
    });

    it('provider rejected: the summary is STILL ready; the email is failed/provider_rejected; no address or provider text stored', async () => {
      const { cid } = await run({ reject: { statusCode: 422, code: 'validation_error' } });
      await until(async () => (await emailOf(cid)).status === 'failed', 'email failed');
      const row = await knex('conversations').where('id', cid).first();
      expect(row.summary_status).toBe('ready'); // email outcome never changes summary readiness
      expect(row.summary_document_id).toBeTruthy();
      expect(await emailOf(cid)).toMatchObject({ status: 'failed', reason: 'provider_rejected' });
      expect(JSON.stringify(row)).not.toMatch(/sentinel|Invalid recipient|Resend/);
    });

    it('provider unavailable is distinguishable from a rejection', async () => {
      const { cid } = await run({ reject: { statusCode: 503 } });
      await until(async () => (await emailOf(cid)).status === 'failed', 'email failed');
      expect(await emailOf(cid)).toMatchObject({ reason: 'provider_unavailable' });
    });
  });
});
