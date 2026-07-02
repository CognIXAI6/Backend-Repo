import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_transcript_segments', (table) => {
    table.uuid('recording_session_id').nullable();
    table.index(
      ['conversation_id', 'recording_session_id', 'deepgram_speaker_id'],
      'idx_segments_recording_speaker',
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_transcript_segments', (table) => {
    table.dropIndex(
      ['conversation_id', 'recording_session_id', 'deepgram_speaker_id'],
      'idx_segments_recording_speaker',
    );
    table.dropColumn('recording_session_id');
  });
}
