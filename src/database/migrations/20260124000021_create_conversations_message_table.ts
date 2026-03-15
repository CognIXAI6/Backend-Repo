import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversation_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('conversation_id')
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE')
      .index();
    table.enum('role', ['user', 'assistant']).notNullable();
    table.text('content').notNullable();
    table.text('transcript').nullable().comment('Deepgram transcript for user messages');
    table.string('audio_url').nullable().comment('Cloudinary URL of recorded audio');
    table.integer('audio_duration_ms').nullable();
    table.string('speaker_label', 100).nullable();
    table.integer('tokens_used').nullable();
    table.integer('latency_ms').nullable().comment('Time from transcript to first AI token ms');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversation_messages');
}