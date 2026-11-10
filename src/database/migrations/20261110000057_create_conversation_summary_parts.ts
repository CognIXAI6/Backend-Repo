import { Knex } from 'knex';

/**
 * One row per auto-summarised stretch of a conversation. A conversation can
 * be resumed after its summary is generated; each later stop summarises only
 * the messages added since the previous part (covers_to), and the stored
 * parts are stitched into one cumulative document, partitioned by session
 * date and topic. covers_from/covers_to are copied from message created_at
 * inside SQL (never round-tripped through JS) to keep microsecond precision.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversation_summary_parts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    table.string('title', 255).notNullable();
    table.text('topic').nullable();
    table.jsonb('sections').notNullable();
    table.timestamp('covers_from', { useTz: true }).notNullable();
    table.timestamp('covers_to', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['conversation_id', 'covers_to']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversation_summary_parts');
}
