import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversation_transcript_segments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('conversation_id')
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');
    table
      .uuid('message_id')
      .nullable()
      .references('id')
      .inTable('conversation_messages')
      .onDelete('SET NULL');
    table
      .uuid('speaker_id')
      .nullable()
      .references('id')
      .inTable('speakers')
      .onDelete('SET NULL');
    table.integer('deepgram_speaker_id').nullable();
    table.string('speaker_label', 100).notNullable();
    table.text('transcript').notNullable();
    table.integer('start_ms').nullable();
    table.integer('end_ms').nullable();
    table.decimal('confidence', 5, 4).nullable();
    table.string('identification_method', 32).notNullable().defaultTo('unknown');
    table.boolean('is_corrected').notNullable().defaultTo(false);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['conversation_id', 'created_at']);
    table.index(['conversation_id', 'deepgram_speaker_id']);
    table.index(['speaker_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversation_transcript_segments');
}
