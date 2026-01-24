import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Voice samples
  await knex.schema.createTable('voice_samples', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.uuid('speaker_id').references('id').inTable('speakers').onDelete('CASCADE').nullable();
    table.string('audio_url').notNullable();
    table.integer('duration_seconds').notNullable();
    table.jsonb('voice_profile').nullable(); // Store voice recognition data
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('voice_samples');
}
