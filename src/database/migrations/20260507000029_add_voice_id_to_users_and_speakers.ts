import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.string('voice_speaker_id').nullable();
    t.string('voice_embedding_id').nullable();
  });

  await knex.schema.alterTable('speakers', (t) => {
    t.string('voice_speaker_id').nullable();
    t.string('voice_embedding_id').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('voice_speaker_id');
    t.dropColumn('voice_embedding_id');
  });

  await knex.schema.alterTable('speakers', (t) => {
    t.dropColumn('voice_speaker_id');
    t.dropColumn('voice_embedding_id');
  });
}
