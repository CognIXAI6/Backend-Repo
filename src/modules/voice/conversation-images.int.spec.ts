/**
 * Integration tests (real Postgres): an uploaded image is analysed once. Reproduces the reported bug —
 * upload invitation (A), get insights, upload payment proof (B): B's insights must not include A.
 * Skipped unless TIMING_IT_DB_PORT is set (see recording-timing.service.int.spec.ts).
 */
import { ConfigService } from '@nestjs/config';
import knexFactory, { Knex } from 'knex';
import { ConversationService } from './services/conversation.service';

const enabled = !!process.env.TIMING_IT_DB_PORT;
const d = enabled ? describe : describe.skip;

d('conversation images: analysed once (real Postgres)', () => {
  let knex: Knex;
  let svc: ConversationService;
  let owner: string;
  let other: string;
  let conv: string;

  beforeAll(async () => {
    knex = knexFactory({
      client: 'pg',
      connection: { host: '127.0.0.1', port: Number(process.env.TIMING_IT_DB_PORT), user: 'postgres', password: 'x', database: process.env.TIMING_IT_DB_NAME ?? 'cognix_test' },
    });
    svc = new ConversationService(knex, { get: jest.fn() } as unknown as ConfigService);
    const tag = Date.now();
    [{ id: owner }] = await knex('users').insert({ email: `img-a-${tag}@example.com` }).returning('id');
    [{ id: other }] = await knex('users').insert({ email: `img-b-${tag}@example.com` }).returning('id');
  });
  afterAll(async () => {
    await knex('users').whereIn('id', [owner, other]).delete();
    await knex.destroy();
  });
  beforeEach(async () => {
    [{ id: conv }] = await knex('conversations').insert({ user_id: owner, total_messages: 0 }).returning('id');
  });

  const upload = (filename: string) =>
    svc.saveConversationImage({ conversationId: conv, userId: owner, filename, mimeType: 'image/jpeg', fileUrl: `u/${filename}`, imageBase64: `b64:${filename}` } as any);

  it('the reported scenario: after A is analysed, uploading B sends ONLY B — A is named, not re-attached', async () => {
    const a = await upload('invitation-card.jpg');
    expect((await svc.getPendingImagesForAI(conv, owner)).map((i) => i.filename)).toEqual(['invitation-card.jpg']); // A's turn

    expect(await svc.markImagesSentToAi(conv, owner, [a.id])).toBe(1); // A's response completed

    await upload('payment-proof.png');
    expect((await svc.getPendingImagesForAI(conv, owner)).map((i) => i.filename)).toEqual(['payment-proof.png']); // B's turn: only B
    expect(await svc.getAnalysedImageNames(conv, owner)).toEqual(['invitation-card.jpg']); // A: name only
  });

  it('an image whose AI call never completed stays pending, so it is retried rather than lost', async () => {
    await upload('a.jpg');
    expect(await svc.getPendingImagesForAI(conv, owner)).toHaveLength(1);
    expect(await svc.getPendingImagesForAI(conv, owner)).toHaveLength(1); // reading does not consume it
  });

  it('several uploads before one prompt are all sent together (oldest first), and the cap leaves the rest pending for the next call', async () => {
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8']) await upload(`f${n}.jpg`);
    const first = await svc.getPendingImagesForAI(conv, owner, 6);
    expect(first.map((i) => i.filename)).toEqual(['f1.jpg', 'f2.jpg', 'f3.jpg', 'f4.jpg', 'f5.jpg', 'f6.jpg']);
    await svc.markImagesSentToAi(conv, owner, first.map((i) => i.id));
    expect((await svc.getPendingImagesForAI(conv, owner, 6)).map((i) => i.filename)).toEqual(['f7.jpg', 'f8.jpg']);
  });

  it('marking and listing are scoped to the owner and to the conversation', async () => {
    const a = await upload('mine.jpg');
    expect(await svc.markImagesSentToAi(conv, other, [a.id])).toBe(0);
    expect((await svc.getPendingImagesForAI(conv, owner)).length).toBe(1);
    expect(await svc.getPendingImagesForAI(conv, other)).toEqual([]);
    expect(await svc.getAnalysedImageNames(conv, other)).toEqual([]);
    const [{ id: conv2 }] = await knex('conversations').insert({ user_id: owner, total_messages: 0 }).returning('id');
    expect(await svc.markImagesSentToAi(conv2, owner, [a.id])).toBe(0); // an image id from a different conversation is not touched
    expect(await svc.markImagesSentToAi(conv, owner, [])).toBe(0);
  });

  it('the display list still shows every image ever attached (only AI attachment changed)', async () => {
    const a = await upload('one.jpg');
    await svc.markImagesSentToAi(conv, owner, [a.id]);
    await upload('two.jpg');
    expect((await svc.listConversationImages(conv, owner)).map((i) => i.filename)).toEqual(['one.jpg', 'two.jpg']);
  });
});
