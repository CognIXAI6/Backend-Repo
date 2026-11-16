import { Knex } from 'knex';

/**
 * Provider speaker numbers (deepgram_speaker_id) are only meaningful within
 * ONE provider connection: after a provider reconnect the numbering can
 * restart, so "speaker 0" in epoch 1 may be a different person than "speaker
 * 0" in epoch 0 of the same recording session. provider_epoch (the gateway's
 * incrementing provider-connection counter) scopes the number. Legacy rows
 * stay NULL and are never matched by scoped updates.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_transcript_segments', (table) => {
    table.integer('provider_epoch').nullable();
    table.index(
      ['conversation_id', 'recording_session_id', 'provider_epoch', 'deepgram_speaker_id'],
      'idx_segments_recording_epoch_speaker',
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_transcript_segments', (table) => {
    table.dropIndex(
      ['conversation_id', 'recording_session_id', 'provider_epoch', 'deepgram_speaker_id'],
      'idx_segments_recording_epoch_speaker',
    );
    table.dropColumn('provider_epoch');
  });
}
