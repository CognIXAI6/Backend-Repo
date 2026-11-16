/**
 * Integration tests (real Postgres): a conversation id alone never grants access.
 * Every conversation-scoped ConversationService helper is exercised as the owner
 * (works) and as another user (reads nothing, writes nothing, throws where it is a
 * write) — and the other user's attempt leaves the owner's data untouched.
 * Skipped unless TIMING_IT_DB_PORT is set (see recording-timing.service.int.spec.ts).
 */
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import knexFactory, { Knex } from 'knex';
import { ConversationService } from './services/conversation.service';
import { ChatMessageService } from '../chat/chat-message.service';

const enabled = !!process.env.TIMING_IT_DB_PORT;
const d = enabled ? describe : describe.skip;

d('conversation ownership (real Postgres)', () => {
  let knex: Knex;
  let svc: ConversationService;
  let owner: string;
  let other: string;
  let conv: string; // the owner's conversation
  let msgFirst: string;
  let msgLast: string;

  beforeAll(async () => {
    knex = knexFactory({
      client: 'pg',
      connection: { host: '127.0.0.1', port: Number(process.env.TIMING_IT_DB_PORT), user: 'postgres', password: 'x', database: process.env.TIMING_IT_DB_NAME ?? 'cognix_test' },
    });
    svc = new ConversationService(knex, { get: jest.fn() } as unknown as ConfigService);
    const tag = Date.now();
    [{ id: owner }] = await knex('users').insert({ email: `own-a-${tag}@example.com` }).returning('id');
    [{ id: other }] = await knex('users').insert({ email: `own-b-${tag}@example.com` }).returning('id');
  });
  afterAll(async () => {
    await knex('users').whereIn('id', [owner, other]).delete();
    await knex.destroy();
  });

  beforeEach(async () => {
    [{ id: conv }] = await knex('conversations').insert({ user_id: owner, title: null, total_messages: 2, last_activity_at: new Date() }).returning('id');
    [{ id: msgFirst }] = await knex('conversation_messages').insert({ conversation_id: conv, role: 'user', content: 'hello', speaker_label: 'owner', created_at: new Date(Date.UTC(2026, 10, 10, 9, 0)) }).returning('id');
    [{ id: msgLast }] = await knex('conversation_messages').insert({ conversation_id: conv, role: 'assistant', content: 'hi', created_at: new Date(Date.UTC(2026, 10, 10, 9, 1)) }).returning('id');
  });

  const convRow = () => knex('conversations').where('id', conv).first();
  const messages = () => knex('conversation_messages').where('conversation_id', conv).orderBy('created_at').select('content', 'speaker_label', 'role');

  describe('reads return nothing for another user', () => {
    it('field, title, history, parts, unsummarised messages, participants, documents, images', async () => {
      await knex('conversations').where('id', conv).update({ title: 'Private title' });
      await knex('conversation_participants').insert({ conversation_id: conv, user_id: owner, display_name: 'Alice', role: 'participant' });
      await knex('conversation_documents').insert({ conversation_id: conv, user_id: owner, filename: 'secret.pdf', mime_type: 'application/pdf', content_markdown: 'x', char_count: 1 });
      await knex('conversation_images').insert({ conversation_id: conv, user_id: owner, filename: 'a.png', mime_type: 'image/png', file_url: 'u', image_base64: 'b', sent_to_ai: false });
      await svc.addSummaryPart(conv, owner, { title: 'P', topic: null, sections: [] }, msgFirst, msgFirst);

      // the owner sees everything…
      expect(await svc.getConversationTitle(conv, owner)).toBe('Private title');
      expect((await svc.getRecentHistoryForAI(conv, owner)).map((m) => m.content)).toEqual(['hello', 'hi']);
      expect(await svc.getSummaryParts(conv, owner)).toHaveLength(1);
      expect((await svc.getUnsummarizedMessages(conv, owner)).map((m: any) => m.content)).toEqual(['hi']);
      expect(await svc.getConversationParticipants(conv, owner)).toHaveLength(1);
      expect(await svc.listConversationDocuments(conv, owner)).toHaveLength(1);
      expect(await svc.listConversationImages(conv, owner)).toHaveLength(1);
      expect(await svc.getConversationImagesForAI(conv, owner)).toHaveLength(1);

      // …another user sees nothing, and nothing says whether the id exists
      expect(await svc.getConversationFieldId(conv, other)).toBeNull();
      expect(await svc.getConversationTitle(conv, other)).toBeNull();
      expect(await svc.getRecentHistoryForAI(conv, other)).toEqual([]);
      expect(await svc.getSummaryParts(conv, other)).toEqual([]);
      expect(await svc.getUnsummarizedMessages(conv, other)).toEqual([]);
      expect(await svc.getConversationParticipants(conv, other)).toEqual([]);
      expect(await svc.listConversationDocuments(conv, other)).toEqual([]);
      expect(await svc.listConversationImages(conv, other)).toEqual([]);
      expect(await svc.getConversationImagesForAI(conv, other)).toEqual([]);
      expect(await svc.getConversationFieldId('00000000-0000-0000-0000-000000000000', other)).toBeNull(); // same as a nonexistent id
    });
  });

  describe('status updates and writes by another user change nothing', () => {
    it('title, summary status, claim, email status', async () => {
      expect(await svc.setTitle(conv, other, 'Hijacked')).toBe(false);
      await svc.setSummaryStatus(conv, other, 'failed', { skipReason: 'x' });
      expect(await svc.claimSummaryGeneration(conv, other)).toBe(false);
      expect(await svc.setSummaryEmailStatus(conv, other, { status: 'failed', reason: 'unknown_error', documentId: null })).toBe(false);
      const row = await convRow();
      expect([row.title, row.summary_status, row.summary_email_status]).toEqual([null, 'not_started', null]);

      // …while the owner can
      expect(await svc.setTitle(conv, owner, 'Mine')).toBe(true);
      expect(await svc.claimSummaryGeneration(conv, owner)).toBe(true);
      await svc.setSummaryStatus(conv, owner, 'ready');
      expect((await convRow()).summary_status).toBe('ready');
    });

    it('summary parts: only the owner can add one, and only over messages of THAT conversation', async () => {
      await expect(svc.addSummaryPart(conv, other, { title: 'P', topic: null, sections: [] }, msgFirst, msgLast)).rejects.toBeInstanceOf(NotFoundException);
      expect(await knex('conversation_summary_parts').where('conversation_id', conv)).toHaveLength(0);

      const [{ id: foreignConv }] = await knex('conversations').insert({ user_id: other, total_messages: 1 }).returning('id');
      const [{ id: foreignMsg }] = await knex('conversation_messages').insert({ conversation_id: foreignConv, role: 'user', content: 'elsewhere' }).returning('id');
      // an owner passing a message id from someone else's conversation does not get a foreign timestamp copied in
      await expect(svc.addSummaryPart(conv, owner, { title: 'P', topic: null, sections: [] }, foreignMsg, msgLast)).rejects.toThrow();
      expect(await knex('conversation_summary_parts').where('conversation_id', conv)).toHaveLength(0);

      await svc.addSummaryPart(conv, owner, { title: 'P', topic: null, sections: [] }, msgFirst, msgLast);
      expect(await knex('conversation_summary_parts').where('conversation_id', conv)).toHaveLength(1);
    });

    it('speaker relabelling and transcript-segment identity changes', async () => {
      await svc.relabelSpeakers(conv, other);
      expect((await messages())[0].speaker_label).toBe('owner'); // untouched
      await svc.relabelSpeakers(conv, owner);
      expect((await messages())[0].speaker_label).toBe('other'); // owner's call works

      const rec = '11111111-1111-1111-1111-111111111111';
      await knex('conversation_transcript_segments').insert({
        conversation_id: conv, deepgram_speaker_id: 0, recording_session_id: rec, provider_epoch: 0,
        speaker_label: 'Guest 1', transcript: 't', identification_method: 'diarization',
      });
      const [{ id: spk }] = await knex('speakers').insert({ user_id: owner, name: 'Bob' }).returning('id');
      const scope = { conversationId: conv, deepgramSpeakerId: 0, recordingSessionId: rec, providerEpoch: 0 };
      expect(await svc.updateTranscriptSpeakerByDeepgramId({ ...scope, userId: other, speakerId: spk, speakerLabel: 'Bob', identificationMethod: 'voice_id' })).toBe(0);
      await svc.correctTranscriptSpeaker({ ...scope, userId: other, speakerId: spk, speakerLabel: 'Bob', applyTo: 'session_speaker' });
      await svc.renameAnonymousSpeaker({ ...scope, userId: other, speakerLabel: 'Hijack', applyTo: 'session_speaker' });
      expect((await knex('conversation_transcript_segments').where('conversation_id', conv).first()).speaker_label).toBe('Guest 1');
      expect(await svc.updateTranscriptSpeakerByDeepgramId({ ...scope, userId: owner, speakerId: spk, speakerLabel: 'Bob', identificationMethod: 'voice_id' })).toBe(1);
    });

    it('participants, images and documents cannot be written into someone else\'s conversation', async () => {
      await expect(svc.upsertConversationParticipant({ conversationId: conv, userId: other, displayName: 'Mallory', role: 'participant' } as any)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.saveConversationImage({ conversationId: conv, userId: other, filename: 'x', mimeType: 'image/png', fileUrl: 'u', imageBase64: 'b' } as any)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.saveConversationDocument({ conversationId: conv, userId: other, filename: 'x', mimeType: 'text/plain', fileUrl: null, contentMarkdown: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      for (const table of ['conversation_participants', 'conversation_images', 'conversation_documents']) {
        expect(await knex(table).where('conversation_id', conv)).toHaveLength(0);
      }
      await svc.upsertConversationParticipant({ conversationId: conv, userId: owner, displayName: 'Alice', role: 'participant' } as any);
      expect(await knex('conversation_participants').where('conversation_id', conv)).toHaveLength(1);
    });

    it('messages and transcript segments cannot be appended to someone else\'s conversation', async () => {
      const before = (await messages()).length;
      await expect(svc.saveMessage({ conversationId: conv, userId: other, role: 'user', content: 'injected' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.saveMessageWithTranscriptSegments({ conversationId: conv, userId: other, role: 'user', content: 'injected' }, [
        { conversationId: conv, speakerLabel: 'x', transcript: 'injected', identificationMethod: 'unknown' },
      ])).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.saveTranscriptSegments([{ conversationId: conv, speakerLabel: 'x', transcript: 'injected', identificationMethod: 'unknown' }], other)).rejects.toBeInstanceOf(NotFoundException);
      expect((await messages()).length).toBe(before);
      expect(await knex('conversation_transcript_segments').where('conversation_id', conv)).toHaveLength(0);
      expect((await convRow()).total_messages).toBe(2); // counters untouched

      const saved = await svc.saveMessage({ conversationId: conv, userId: owner, role: 'user', content: 'legit' });
      expect(saved.content).toBe('legit');
    });

    it('segments saved with a message always land in the message\'s own conversation, never one named in a segment', async () => {
      const [{ id: foreignConv }] = await knex('conversations').insert({ user_id: other, total_messages: 0 }).returning('id');
      await svc.saveMessageWithTranscriptSegments({ conversationId: conv, userId: owner, role: 'user', content: 'x' }, [
        { conversationId: foreignConv, speakerLabel: 's', transcript: 'sneaky', identificationMethod: 'unknown' },
      ]);
      expect(await knex('conversation_transcript_segments').where('conversation_id', foreignConv)).toHaveLength(0);
      expect(await knex('conversation_transcript_segments').where('conversation_id', conv)).toHaveLength(1);
    });
  });

  it('a soft-deleted conversation is invisible to reads and status helpers even for its owner', async () => {
    await knex('conversations').where('id', conv).update({ deleted_at: new Date(), field_id: null, title: 'Gone' });
    expect(await svc.getConversationTitle(conv, owner)).toBeNull();
    expect(await svc.getRecentHistoryForAI(conv, owner)).toEqual([]);
    expect(await svc.claimSummaryGeneration(conv, owner)).toBe(false);
    expect(await svc.setTitle(conv, owner, 'x')).toBe(false);
  });

  describe('durable chat command path', () => {
    const build = () => {
      const usage: any = { tryConsume: jest.fn().mockResolvedValue({ canUse: true, limit: 100 }) };
      const entitlements: any = { getUserEntitlements: jest.fn().mockResolvedValue({ entitlements: { maxMessagesPerMonth: 100 } }) };
      const fields: any = {
        resolveAuthorizedField: jest.fn().mockResolvedValue(null),
        getUserPrimaryField: jest.fn().mockResolvedValue(null),
      };
      return { chat: new ChatMessageService(knex, svc, entitlements, usage, fields), usage };
    };
    const MSG = '33333333-3333-3333-3333-333333333333';

    it('another user cannot probe or write a conversation (or consume quota against it) through POST /chat/messages', async () => {
      const { chat, usage } = build();
      await expect(chat.submitMessage(other, { clientMessageId: MSG, conversationId: conv, text: 'hi' } as any)).rejects.toBeInstanceOf(NotFoundException);
      expect(usage.tryConsume).not.toHaveBeenCalled();
      expect(await knex('conversation_messages').where({ conversation_id: conv, client_message_id: MSG })).toHaveLength(0);
    });

    it('the owner can, and the stored message carries the idempotency key', async () => {
      const { chat } = build();
      const first = await chat.submitMessage(owner, { clientMessageId: MSG, conversationId: conv, text: 'hello again' } as any);
      const replay = await chat.submitMessage(owner, { clientMessageId: MSG, conversationId: conv, text: 'hello again' } as any);
      expect(replay.messageId).toBe(first.messageId);
      expect(await knex('conversation_messages').where({ conversation_id: conv, client_message_id: MSG })).toHaveLength(1);
    });

    it('a new conversation started with a field id the user may not use is created WITHOUT that field', async () => {
      const [{ id: foreignField }] = await knex('custom_fields').insert({ user_id: other, name: `Other practice ${Date.now()}` }).returning('id');
      const { chat } = build();
      const result = await chat.submitMessage(owner, { clientMessageId: '44444444-4444-4444-4444-444444444444', text: 'hi', fieldId: foreignField } as any);
      expect(await svc.getConversationFieldId(result.conversationId, owner)).toBeNull();
    });
  });
});
