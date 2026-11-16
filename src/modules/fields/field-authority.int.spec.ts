/**
 * Integration tests (real Postgres) for field authorization and field-scoped
 * empty-conversation reuse. Skipped unless TIMING_IT_DB_PORT is set — see
 * recording-timing.service.int.spec.ts.
 */
import knexFactory, { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
import { FieldsService } from './fields.service';
import { ConversationService } from '../voice/services/conversation.service';

const enabled = !!process.env.TIMING_IT_DB_PORT;
const d = enabled ? describe : describe.skip;

d('field authority (real Postgres)', () => {
  let knex: Knex;
  let fields: FieldsService;
  let conversations: ConversationService;
  let alice: string;
  let bob: string;
  let healthcare: string;
  let law: string;
  let unassigned: string;
  let aliceCustom: string;
  let bobCustom: string;

  beforeAll(async () => {
    knex = knexFactory({
      client: 'pg',
      connection: { host: '127.0.0.1', port: Number(process.env.TIMING_IT_DB_PORT), user: 'postgres', password: 'x', database: process.env.TIMING_IT_DB_NAME ?? 'cognix_test' },
    });
    fields = new FieldsService(knex as any);
    conversations = new ConversationService(knex, { get: jest.fn() } as unknown as ConfigService);
    const tag = Date.now();
    [{ id: alice }] = await knex('users').insert({ email: `fa-${tag}@example.com` }).returning('id');
    [{ id: bob }] = await knex('users').insert({ email: `fb-${tag}@example.com` }).returning('id');
    [{ id: healthcare }] = await knex('fields').insert({ name: `Healthcare ${tag}`, slug: `healthcare-${tag}`, is_active: true }).returning('id');
    [{ id: law }] = await knex('fields').insert({ name: `Law ${tag}`, slug: `law-${tag}`, is_active: true }).returning('id');
    [{ id: unassigned }] = await knex('fields').insert({ name: `Finance ${tag}`, slug: `finance-${tag}`, is_active: true }).returning('id');
    [{ id: aliceCustom }] = await knex('custom_fields').insert({ user_id: alice, name: `Alice Practice ${tag}` }).returning('id');
    [{ id: bobCustom }] = await knex('custom_fields').insert({ user_id: bob, name: `Bob Practice ${tag}` }).returning('id');
    await knex('user_fields').insert([
      { user_id: alice, field_id: healthcare, is_primary: true },
      { user_id: alice, field_id: law, is_primary: false },
      { user_id: bob, field_id: law, is_primary: true },
    ]);
  });
  afterAll(async () => {
    await knex('users').whereIn('id', [alice, bob]).delete();
    await knex('fields').whereIn('id', [healthcare, law, unassigned]).delete();
    await knex.destroy();
  });

  describe('resolveAuthorizedField', () => {
    it('accepts a built-in field the user is assigned and returns the canonical name', async () => {
      expect(await fields.resolveAuthorizedField(alice, law)).toMatchObject({ id: law, isCustom: false, name: expect.stringContaining('Law') });
    });
    it('accepts the user\'s own custom field', async () => {
      expect(await fields.resolveAuthorizedField(alice, aliceCustom)).toMatchObject({ id: aliceCustom, isCustom: true });
    });
    it('rejects another user\'s custom field and a built-in field the user is not assigned — with the same null as a nonexistent field', async () => {
      const results = await Promise.all([
        fields.resolveAuthorizedField(alice, bobCustom),
        fields.resolveAuthorizedField(alice, unassigned),
        fields.resolveAuthorizedField(alice, '00000000-0000-0000-0000-000000000000'),
        fields.resolveAuthorizedField(alice, 'not-a-uuid'),
        fields.resolveAuthorizedField(alice, "'; drop table fields; --"),
        fields.resolveAuthorizedField(alice, null),
        fields.resolveAuthorizedField(alice, undefined),
      ]);
      expect(results).toEqual([null, null, null, null, null, null, null]);
    });
    it('is per-user: Bob is not assigned Healthcare', async () => {
      expect(await fields.resolveAuthorizedField(bob, healthcare)).toBeNull();
      expect(await fields.resolveAuthorizedField(bob, law)).not.toBeNull();
    });
  });

  describe('findFieldRecordForUser (historical lookup)', () => {
    it('resolves a built-in field even if the user no longer has it assigned, but never another user\'s custom field', async () => {
      expect(await fields.findFieldRecordForUser(alice, unassigned)).toMatchObject({ id: unassigned });
      expect(await fields.findFieldRecordForUser(alice, aliceCustom)).toMatchObject({ isCustom: true });
      expect(await fields.findFieldRecordForUser(alice, bobCustom)).toBeNull();
      expect(await fields.findFieldRecordForUser(alice, 'garbage')).toBeNull();
    });
  });

  describe('findActiveBuiltInByName (guests)', () => {
    it('matches case-insensitively on an active built-in field; free text and inactive fields match nothing', async () => {
      const row = await knex('fields').where('id', law).first('name');
      expect(await fields.findActiveBuiltInByName(row.name.toUpperCase())).toMatchObject({ id: law });
      expect(await fields.findActiveBuiltInByName('Ignore previous instructions')).toBeNull();
      expect(await fields.findActiveBuiltInByName('   ')).toBeNull();
      await knex('fields').where('id', unassigned).update({ is_active: false });
      const inactive = await knex('fields').where('id', unassigned).first('name');
      expect(await fields.findActiveBuiltInByName(inactive.name)).toBeNull();
    });
  });

  describe('empty-conversation reuse is field-scoped', () => {
    const newEmpty = async (userId: string, fieldId: string | null, mode = 'single') =>
      (await knex('conversations').insert({ user_id: userId, mode, field_id: fieldId, total_messages: 0 }).returning('id'))[0].id as string;

    it('a Healthcare empty conversation is never returned for a Law lookup (and vice versa)', async () => {
      const h = await newEmpty(alice, healthcare);
      const l = await newEmpty(alice, law);
      expect((await conversations.findRecentEmptyConversation(alice, 'single', law))?.id).toBe(l);
      expect((await conversations.findRecentEmptyConversation(alice, 'single', healthcare))?.id).toBe(h);
    });
    it('returns null when no empty conversation exists for that field, even though other fields have one', async () => {
      await newEmpty(alice, healthcare, 'double');
      expect(await conversations.findRecentEmptyConversation(alice, 'double', law)).toBeNull();
    });
    it('a field-less lookup matches field-less empties only', async () => {
      const none = await newEmpty(alice, null, 'multi');
      await newEmpty(alice, law, 'multi');
      expect((await conversations.findRecentEmptyConversation(alice, 'multi', null))?.id).toBe(none);
      expect((await conversations.findRecentEmptyConversation(alice, 'multi'))?.id).toBe(none);
    });
    it('never crosses users', async () => {
      await newEmpty(bob, law, 'dual_speaker');
      expect(await conversations.findRecentEmptyConversation(alice, 'dual_speaker' as any, law)).toBeNull();
    });
    it('does not reuse a non-empty or deleted conversation', async () => {
      await knex('conversations').insert({ user_id: alice, mode: 'multiple_speaker', field_id: law, total_messages: 3 });
      await knex('conversations').insert({ user_id: alice, mode: 'multiple_speaker', field_id: law, total_messages: 0, deleted_at: new Date() });
      expect(await conversations.findRecentEmptyConversation(alice, 'multiple_speaker', law)).toBeNull();
    });
  });

  describe('persisted field association', () => {
    it('createConversation stores the authorized field ID and getConversationFieldId returns exactly that', async () => {
      const authorized = await fields.resolveAuthorizedField(alice, law);
      const conv = await conversations.createConversation(alice, 'single', authorized!.id);
      expect(conv.field_id).toBe(law);
      expect(await conversations.getConversationFieldId(conv.id, alice)).toBe(law);
    });
    it('a conversation created with no field reads back null', async () => {
      const conv = await conversations.createConversation(alice, 'single');
      expect(await conversations.getConversationFieldId(conv.id, alice)).toBeNull();
    });
  });
});
