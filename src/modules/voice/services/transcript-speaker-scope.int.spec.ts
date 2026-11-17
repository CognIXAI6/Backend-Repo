/**
 * Integration tests (real Postgres) for provider-speaker scoping. Skipped
 * unless TIMING_IT_DB_PORT is set — see recording-timing.service.int.spec.ts.
 */
import knexFactory, { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
import { ConversationService } from './conversation.service';

const enabled = !!process.env.TIMING_IT_DB_PORT;
const d = enabled ? describe : describe.skip;

d('transcript speaker scoping (real Postgres)', () => {
  let knex: Knex;
  let svc: ConversationService;
  let userId: string;
  let aliceId: string;
  let bobId: string;

  const conv = async () => (await knex('conversations').insert({ user_id: userId }).returning('id'))[0].id as string;
  const seg = (conversationId: string, o: Partial<{ spk: number | null; rec: string; epoch: number | null; label: string; speakerId: string | null; method: string; corrected: boolean; text: string }> = {}) =>
    knex('conversation_transcript_segments').insert({
      conversation_id: conversationId,
      deepgram_speaker_id: o.spk === undefined ? 0 : o.spk,
      recording_session_id: o.rec ?? '11111111-1111-1111-1111-111111111111',
      provider_epoch: o.epoch === undefined ? 0 : o.epoch,
      speaker_label: o.label ?? 'Guest 1',
      speaker_id: o.speakerId ?? null,
      identification_method: o.method ?? 'diarization',
      is_corrected: o.corrected ?? false,
      transcript: o.text ?? 't',
    });
  const rows = (cid: string) => knex('conversation_transcript_segments').where('conversation_id', cid).orderBy('created_at').orderBy('transcript');
  const scope = (over: object = {}) => ({ recordingSessionId: '11111111-1111-1111-1111-111111111111', providerEpoch: 0, ...over });

  beforeAll(async () => {
    knex = knexFactory({
      client: 'pg',
      connection: { host: '127.0.0.1', port: Number(process.env.TIMING_IT_DB_PORT), user: 'postgres', password: 'x', database: process.env.TIMING_IT_DB_NAME ?? 'cognix_test' },
    });
    svc = new ConversationService(knex, { get: jest.fn() } as unknown as ConfigService);
    [{ id: userId }] = await knex('users').insert({ email: `seg-${Date.now()}@example.com` }).returning('id');
    [{ id: aliceId }] = await knex('speakers').insert({ user_id: userId, name: 'Alice' }).returning('id');
    [{ id: bobId }] = await knex('speakers').insert({ user_id: userId, name: 'Bob' }).returning('id');
  });
  afterAll(async () => {
    await knex('users').where('id', userId).delete();
    await knex.destroy();
  });

  it('round-trips recording session and provider epoch, keeping two speakers\' numbers separate after reload', async () => {
    const c = await conv();
    await svc.saveTranscriptSegments([
      { conversationId: c, deepgramSpeakerId: 0, speakerLabel: 'Guest 1', transcript: 'a', identificationMethod: 'diarization', recordingSessionId: '11111111-1111-1111-1111-111111111111', providerEpoch: 0 },
      { conversationId: c, deepgramSpeakerId: 1, speakerLabel: 'Guest 2', transcript: 'b', identificationMethod: 'diarization', recordingSessionId: '11111111-1111-1111-1111-111111111111', providerEpoch: 0 },
      { conversationId: c, deepgramSpeakerId: 0, speakerLabel: 'Guest 1', transcript: 'c', identificationMethod: 'diarization', recordingSessionId: '11111111-1111-1111-1111-111111111111', providerEpoch: 0 },
      { conversationId: c, deepgramSpeakerId: null, speakerLabel: 'Unknown speaker', transcript: 'd', identificationMethod: 'unknown', recordingSessionId: '11111111-1111-1111-1111-111111111111', providerEpoch: 1 },
    ], userId);
    const all = (await rows(c)).map((r: any) => [r.transcript, r.deepgram_speaker_id, r.provider_epoch, r.speaker_label]);
    expect(all).toEqual([['a', 0, 0, 'Guest 1'], ['b', 1, 0, 'Guest 2'], ['c', 0, 0, 'Guest 1'], ['d', null, 1, 'Unknown speaker']]);
  });

  it('voice-ID for ordinal 0 in epoch 1 (Bob) never rewrites epoch 0 ordinal 0 (confirmed Alice)', async () => {
    const c = await conv();
    await seg(c, { epoch: 0, spk: 0, label: 'Alice', speakerId: aliceId, method: 'voice_id', text: 'alice-old' });
    await seg(c, { epoch: 1, spk: 0, label: 'Guest 1', text: 'bob-new' });
    const n = await svc.updateTranscriptSpeakerByDeepgramId({
      conversationId: c, userId, deepgramSpeakerId: 0, speakerId: bobId, speakerLabel: 'Bob', identificationMethod: 'voice_id', ...scope({ providerEpoch: 1 }),
    });
    expect(n).toBe(1);
    const r: any[] = await rows(c);
    expect(r.find((x) => x.transcript === 'alice-old')).toMatchObject({ speaker_label: 'Alice', speaker_id: aliceId });
    expect(r.find((x) => x.transcript === 'bob-new')).toMatchObject({ speaker_label: 'Bob', speaker_id: bobId });
  });

  it('same ordinal in a different recording session (resumed conversation) is untouched', async () => {
    const c = await conv();
    await seg(c, { rec: '22222222-2222-2222-2222-222222222222', epoch: 0, label: 'Alice', speakerId: aliceId, method: 'voice_id', text: 'earlier-recording' });
    await seg(c, { text: 'this-recording' });
    await svc.updateTranscriptSpeakerByDeepgramId({ conversationId: c, userId, deepgramSpeakerId: 0, speakerId: bobId, speakerLabel: 'Bob', identificationMethod: 'voice_id', ...scope() });
    const r: any[] = await rows(c);
    expect(r.find((x) => x.transcript === 'earlier-recording')).toMatchObject({ speaker_label: 'Alice' });
    expect(r.find((x) => x.transcript === 'this-recording')).toMatchObject({ speaker_label: 'Bob' });
  });

  it('a late voice-ID result cannot overwrite a segment already confirmed as a different identity, or a manual correction, in the same scope', async () => {
    const c = await conv();
    await seg(c, { label: 'Alice', speakerId: aliceId, method: 'voice_id', text: 'confirmed-alice' });
    await seg(c, { label: 'Carol', speakerId: aliceId, method: 'manual', corrected: true, text: 'manual' });
    await seg(c, { text: 'anonymous' });
    const n = await svc.updateTranscriptSpeakerByDeepgramId({ conversationId: c, userId, deepgramSpeakerId: 0, speakerId: bobId, speakerLabel: 'Bob', identificationMethod: 'voice_id', ...scope() });
    expect(n).toBe(1);
    const r: any[] = await rows(c);
    expect(r.find((x) => x.transcript === 'confirmed-alice')).toMatchObject({ speaker_label: 'Alice', speaker_id: aliceId });
    expect(r.find((x) => x.transcript === 'manual')).toMatchObject({ speaker_label: 'Carol', is_corrected: true });
    expect(r.find((x) => x.transcript === 'anonymous')).toMatchObject({ speaker_label: 'Bob' });
  });

  it('re-confirming the SAME identity is allowed (idempotent)', async () => {
    const c = await conv();
    await seg(c, { label: 'Alice', speakerId: aliceId, method: 'voice_id', text: 'x' });
    const n = await svc.updateTranscriptSpeakerByDeepgramId({ conversationId: c, userId, deepgramSpeakerId: 0, speakerId: aliceId, speakerLabel: 'Alice', identificationMethod: 'voice_id', ...scope() });
    expect(n).toBe(1);
  });

  it('refuses to widen: no recording session or no epoch → nothing updated; legacy (null-epoch) rows are never matched', async () => {
    const c = await conv();
    await seg(c, { epoch: null, text: 'legacy' });
    await seg(c, { text: 'scoped' });
    const base = { conversationId: c, userId, deepgramSpeakerId: 0, speakerId: bobId, speakerLabel: 'Bob', identificationMethod: 'voice_id' as const };
    expect(await svc.updateTranscriptSpeakerByDeepgramId({ ...base })).toBe(0);
    expect(await svc.updateTranscriptSpeakerByDeepgramId({ ...base, recordingSessionId: '11111111-1111-1111-1111-111111111111' })).toBe(0);
    expect(await svc.updateTranscriptSpeakerByDeepgramId({ ...base, providerEpoch: 0 })).toBe(0);
    expect(((await rows(c)) as any[]).every((r) => r.speaker_label === 'Guest 1')).toBe(true);
    await svc.updateTranscriptSpeakerByDeepgramId({ ...base, ...scope() });
    const r: any[] = await rows(c);
    expect(r.find((x) => x.transcript === 'legacy')).toMatchObject({ speaker_label: 'Guest 1' });
    expect(r.find((x) => x.transcript === 'scoped')).toMatchObject({ speaker_label: 'Bob' });
  });

  it('manual correction (session or conversation scope) only touches the (recording, epoch) the number came from', async () => {
    const c = await conv();
    await seg(c, { epoch: 0, label: 'Alice', speakerId: aliceId, method: 'voice_id', text: 'e0' });
    await seg(c, { epoch: 1, text: 'e1' });
    for (const applyTo of ['session_speaker', 'conversation_speaker'] as const) {
      await svc.correctTranscriptSpeaker({ conversationId: c, userId, deepgramSpeakerId: 0, speakerId: bobId, speakerLabel: 'Bob', applyTo, ...scope({ providerEpoch: 1 }) });
    }
    const r: any[] = await rows(c);
    expect(r.find((x) => x.transcript === 'e0')).toMatchObject({ speaker_label: 'Alice' });
    expect(r.find((x) => x.transcript === 'e1')).toMatchObject({ speaker_label: 'Bob', is_corrected: true, identification_method: 'manual' });
  });

  it('manual correction without scope is rejected (not widened); a single-segment correction still works unscoped', async () => {
    const c = await conv();
    await seg(c, { text: 'one' });
    await expect(svc.correctTranscriptSpeaker({ conversationId: c, userId, deepgramSpeakerId: 0, speakerId: bobId, speakerLabel: 'Bob', applyTo: 'session_speaker' })).rejects.toThrow(/provider epoch/);
    await expect(svc.correctTranscriptSpeaker({ conversationId: c, userId, deepgramSpeakerId: 0, speakerId: bobId, speakerLabel: 'Bob', applyTo: 'conversation_speaker', recordingSessionId: '11111111-1111-1111-1111-111111111111' })).rejects.toThrow();
    await expect(svc.correctTranscriptSpeaker({ conversationId: c, userId, speakerId: bobId, speakerLabel: 'Bob', applyTo: 'segment' })).rejects.toThrow(/segmentId/);
    const [{ id }] = await rows(c);
    await svc.correctTranscriptSpeaker({ conversationId: c, userId, segmentId: id, speakerId: bobId, speakerLabel: 'Bob', applyTo: 'segment' });
    expect(((await rows(c)) as any[])[0]).toMatchObject({ speaker_label: 'Bob', is_corrected: true });
  });

  it('guest rename only touches anonymous rows in scope, never a segment tied to a real identity', async () => {
    const c = await conv();
    await seg(c, { label: 'Alice', speakerId: aliceId, method: 'voice_id', text: 'identified' });
    await seg(c, { text: 'anon-in-scope' });
    await seg(c, { epoch: 1, text: 'anon-other-epoch' });
    await svc.renameAnonymousSpeaker({ conversationId: c, userId, deepgramSpeakerId: 0, speakerLabel: 'Dana', applyTo: 'session_speaker', ...scope() });
    const r: any[] = await rows(c);
    expect(r.find((x) => x.transcript === 'identified')).toMatchObject({ speaker_label: 'Alice' });
    expect(r.find((x) => x.transcript === 'anon-in-scope')).toMatchObject({ speaker_label: 'Dana' });
    expect(r.find((x) => x.transcript === 'anon-other-epoch')).toMatchObject({ speaker_label: 'Guest 1' });
    await expect(svc.renameAnonymousSpeaker({ conversationId: c, userId, deepgramSpeakerId: 0, speakerLabel: 'X', applyTo: 'conversation_speaker' })).rejects.toThrow();
  });

  it('stored segments expose provider_session_epoch (the same value as recording_session_id) on detail and on the segment list; null when there is none', async () => {
    const c = await conv();
    const rec = '11111111-1111-1111-1111-111111111111';
    await seg(c, { rec, epoch: 1, text: 'scoped' });
    await knex('conversation_transcript_segments').insert({ conversation_id: c, speaker_label: 'Old', transcript: 'legacy', identification_method: 'unknown' });
    const list: any[] = await svc.getTranscriptSegments(c, userId);
    expect(list.find((r) => r.transcript === 'scoped')).toMatchObject({ recording_session_id: rec, provider_session_epoch: rec, provider_epoch: 1 });
    expect(list.find((r) => r.transcript === 'legacy')).toMatchObject({ recording_session_id: null, provider_session_epoch: null });
    const detail: any = await svc.getConversation(c, userId);
    expect(detail.transcriptSegments.find((r: any) => r.transcript === 'scoped').provider_session_epoch).toBe(rec);
  });
});
