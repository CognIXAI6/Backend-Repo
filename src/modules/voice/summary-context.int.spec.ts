/**
 * Integration evidence (real Postgres + real ConversationService + the real summary path):
 * a conversation far beyond the old 80-message / 12,000-character limits is summarised from
 * ALL of it, the recorded coverage is the whole range, and — in success AND in injected
 * failures — the stored source messages are byte-for-byte unchanged.
 * Skipped unless TIMING_IT_DB_PORT is set (see recording-timing.service.int.spec.ts).
 */
import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import knexFactory, { Knex } from 'knex';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VoiceGateway } from './voice.gateway';
import { ConversationService } from './services/conversation.service';

const enabled = !!process.env.TIMING_IT_DB_PORT;
const d = enabled ? describe : describe.skip;

d('summary context (real Postgres)', () => {
  let knex: Knex;
  let conversations: ConversationService;
  let userId: string;

  beforeAll(async () => {
    knex = knexFactory({
      client: 'pg',
      connection: { host: '127.0.0.1', port: Number(process.env.TIMING_IT_DB_PORT), user: 'postgres', password: 'x', database: process.env.TIMING_IT_DB_NAME ?? 'cognix_test' },
    });
    conversations = new ConversationService(knex, { get: jest.fn() } as unknown as ConfigService);
    [{ id: userId }] = await knex('users').insert({ email: `sc-${Date.now()}@example.com` }).returning('id');
  });
  afterAll(async () => {
    await knex('users').where('id', userId).delete();
    await knex.destroy();
  });
  beforeEach(() => ['log', 'warn', 'error', 'debug'].forEach((m) => jest.spyOn(Logger.prototype, m as any).mockImplementation(() => undefined)));
  afterEach(() => jest.restoreAllMocks());

  const seed = async (count: number, len: number) => {
    const [{ id: cid }] = await knex('conversations').insert({ user_id: userId, total_messages: count, last_activity_at: new Date() }).returning('id');
    const rows = Array.from({ length: count }, (_, i) => ({
      conversation_id: cid, role: i % 2 ? 'assistant' : 'user', content: `m${i + 1}:`.padEnd(len, 'x'), created_at: new Date(Date.UTC(2026, 10, 10, 9, 0, 0) + i * 1_000),
    }));
    for (let i = 0; i < rows.length; i += 500) await knex('conversation_messages').insert(rows.slice(i, i + 500));
    return cid as string;
  };
  /** A digest of every stored message (ids, order, role, content) — equal before/after means nothing was rewritten or deleted. */
  const digest = async (cid: string) => {
    const rows = await knex('conversation_messages').where('conversation_id', cid).orderBy('created_at').orderBy('id').select('id', 'role', 'content', 'transcript', 'speaker_label', 'document_id');
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex') + `:${rows.length}`;
  };

  const build = (claude: Record<string, jest.Mock>) => {
    const noop = {} as any;
    const generateAndUpload = jest.fn(async (..._args: any[]) => ({ docId: (await knex('generated_documents').insert({ user_id: userId, title: 'd', download_url: 'https://example.com/d' }).returning('id'))[0].id, downloadUrl: 'https://example.com/d' }));
    const gateway: any = new VoiceGateway(
      noop, claude as any, conversations, noop, noop, noop, { findById: jest.fn().mockResolvedValue({ id: userId, email: null }) } as any,
      noop, { sendConversationSummaryEmail: jest.fn() } as any, { log: jest.fn() } as any, noop, noop, noop,
      { generateAndUpload, buildSummaryPdfBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')) } as any,
      { sendToUser: jest.fn().mockResolvedValue(undefined) } as any, noop,
      { getStatus: jest.fn().mockResolvedValue({ canUse: true }), tryConsume: jest.fn().mockResolvedValue(undefined) } as any, noop,
    );
    return { gateway, generateAndUpload };
  };
  const sessionFor = (cid: string): any => ({
    userId, isGuest: false, conversationId: cid, traceId: 'trace-sc', cachedOwnerName: 'Tolu', otherSpeakerName: null, isMultiSpeaker: false,
    entitlements: { maxDocumentsPerMonth: 10, allowedDocumentDepths: ['brief'] }, recordingSessionId: randomUUID(), providerEpoch: 0,
    inFlightTurns: new Set(), deepgramEmitter: new EventEmitter(),
  });
  const goodClaude = () => ({
    summarizeConversationChunk: jest.fn(async (_t: unknown, pos: { index: number }) => `notes ${pos.index}`),
    generateConversationSummaryFromNotes: jest.fn().mockResolvedValue({ title: 'Whole conversation', topic: 't', sections: [{ heading: 'Summary', content: 'S' }] }),
    generateConversationSummaryDocument: jest.fn().mockResolvedValue({ title: 'Short', topic: 't', sections: [{ heading: 'Summary', content: 'S' }] }),
  });

  it('1,000 messages / 200k characters (far past 80 messages and 12,000 chars): the whole range is covered and the source messages are unchanged', async () => {
    const cid = await seed(1_000, 200);
    const before = await digest(cid);
    const claude = goodClaude();
    const { gateway, generateAndUpload } = build(claude);

    await gateway.autoGenerateConversationSummary({ id: 's', emit: jest.fn() }, sessionFor(cid));

    const row = await knex('conversations').where('id', cid).first();
    expect(row.summary_status).toBe('ready');
    const chunkCalls = claude.summarizeConversationChunk.mock.calls;
    expect(chunkCalls.length).toBeGreaterThan(10);
    const sent = chunkCalls.flatMap((c: any[]) => c[0].map((t: any) => t.content));
    expect(sent).toHaveLength(1_000);
    expect(sent[0].startsWith('m1:')).toBe(true);
    expect(sent[499].startsWith('m500:')).toBe(true); // the middle
    expect(sent[999].startsWith('m1000:')).toBe(true);
    expect(claude.generateConversationSummaryFromNotes.mock.calls[0][0]).toHaveLength(chunkCalls.length); // notes from every chunk

    const [part] = await knex('conversation_summary_parts').where('conversation_id', cid);
    const first = await knex('conversation_messages').where('conversation_id', cid).whereNull('document_id').orderBy('created_at').first();
    const last = await knex('conversation_messages').where('conversation_id', cid).whereNull('document_id').orderBy('created_at', 'desc').first(); // the last ORIGINAL message (the summary adds its own 'ready' message after it)
    expect(new Date(part.covers_from).getTime()).toBe(new Date(first.created_at).getTime());
    expect(new Date(part.covers_to).getTime()).toBe(new Date(last.created_at).getTime()); // coverage == the whole conversation
    const sections = generateAndUpload.mock.calls[0][0].sections;
    expect(sections.find((s: any) => s.heading === 'Transcript').content).toContain('m1000:');

    // the summary added a "ready" message with a document; the ORIGINAL messages are unchanged
    const originals = await knex('conversation_messages').where('conversation_id', cid).whereNull('document_id').orderBy('created_at').orderBy('id').select('id', 'role', 'content');
    expect(originals).toHaveLength(1_000);
    expect(originals.every((m: any, i: number) => m.content.startsWith(`m${i + 1}:`))).toBe(true);
    expect(before.endsWith(':1000')).toBe(true);
  }, 60_000);

  it('beyond the hard bound (2,000 messages / 400k chars): a truthful failure — status failed/context_too_large, no part, no document, messages unchanged', async () => {
    const cid = await seed(2_000, 200);
    const before = await digest(cid);
    const claude = goodClaude();
    const { gateway, generateAndUpload } = build(claude);

    await gateway.autoGenerateConversationSummary({ id: 's', emit: jest.fn() }, sessionFor(cid));

    const row = await knex('conversations').where('id', cid).first();
    expect([row.summary_status, row.summary_skip_reason]).toEqual(['failed', 'context_too_large']);
    expect(await knex('conversation_summary_parts').where('conversation_id', cid)).toHaveLength(0);
    expect(generateAndUpload).not.toHaveBeenCalled();
    expect(claude.summarizeConversationChunk).not.toHaveBeenCalled();
    expect(await digest(cid)).toBe(before);
  }, 60_000);

  it('an injected failure part-way (a chunk cannot be condensed): the summary fails, nothing is recorded as covered, messages unchanged — and a later retry covers everything', async () => {
    const cid = await seed(400, 200);
    const before = await digest(cid);
    const failing = { ...goodClaude(), summarizeConversationChunk: jest.fn(async (_t: unknown, pos: { index: number }) => (pos.index === 3 ? null : `notes ${pos.index}`)) };
    const first = build(failing);

    await first.gateway.autoGenerateConversationSummary({ id: 's', emit: jest.fn() }, sessionFor(cid));

    let row = await knex('conversations').where('id', cid).first();
    expect([row.summary_status, row.summary_skip_reason]).toEqual(['failed', 'generation_error']);
    expect(await knex('conversation_summary_parts').where('conversation_id', cid)).toHaveLength(0);
    expect(await digest(cid)).toBe(before);

    // the next stop re-claims the failed summary and, with the model healthy, covers the whole conversation
    const retry = build(goodClaude());
    await retry.gateway.autoGenerateConversationSummary({ id: 's', emit: jest.fn() }, sessionFor(cid));
    row = await knex('conversations').where('id', cid).first();
    expect(row.summary_status).toBe('ready');
    expect(await knex('conversation_summary_parts').where('conversation_id', cid)).toHaveLength(1);
    const originals = await knex('conversation_messages').where('conversation_id', cid).whereNull('document_id');
    expect(originals).toHaveLength(400);
  }, 60_000);

  it('a model timeout is a distinct, retryable failure and leaves the source unchanged', async () => {
    const cid = await seed(400, 200);
    const before = await digest(cid);
    const claude = { ...goodClaude(), generateConversationSummaryFromNotes: jest.fn().mockResolvedValue(null) };
    const { gateway } = build(claude);
    await gateway.autoGenerateConversationSummary({ id: 's', emit: jest.fn() }, sessionFor(cid));
    const row = await knex('conversations').where('id', cid).first();
    expect(row.summary_status).toBe('failed');
    expect(await digest(cid)).toBe(before);
  }, 60_000);

  it('a short conversation is unaffected: one model call, one part', async () => {
    const cid = await seed(6, 80);
    const claude = goodClaude();
    const { gateway } = build(claude);
    await gateway.autoGenerateConversationSummary({ id: 's', emit: jest.fn() }, sessionFor(cid));
    expect(claude.generateConversationSummaryDocument).toHaveBeenCalledTimes(1);
    expect(claude.summarizeConversationChunk).not.toHaveBeenCalled();
    expect((await knex('conversations').where('id', cid).first()).summary_status).toBe('ready');
  }, 30_000);
});
