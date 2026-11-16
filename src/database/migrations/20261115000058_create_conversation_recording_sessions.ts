import { Knex } from 'knex';

/**
 * Durable recording-session timing ledger (additive).
 *
 * One row per *logical* recording session in a conversation. Reconnects and
 * stream/transport id rotations stay inside the same row (client_session_id
 * is the client's stable logical id). `captured_ms` is the length of the
 * union of the captured intervals the client reports (offsets from the
 * session start), validated server-side — it is NOT provider-connected
 * billing time and never includes replayed audio. `elapsed_ms` is the
 * server-observed start→end wall clock.
 *
 * Legacy conversations get no rows (no backfill): "no row" means unknown.
 *
 * conversations.timing_revision is bumped in the same transaction as every
 * effective session write so list and detail responses stay consistent.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversation_recording_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('client_session_id', 64).notNullable();
    table.timestamp('started_at', { useTz: true }).notNullable();
    table.timestamp('ended_at', { useTz: true }).nullable();
    table.integer('elapsed_ms').nullable();
    table.integer('captured_ms').notNullable().defaultTo(0);
    table.jsonb('intervals').notNullable().defaultTo('[]');
    // active | ended | interrupted
    table.string('status', 16).notNullable().defaultTo('active');
    // complete only when the client sent a final report; otherwise partial.
    table.string('completeness', 16).notNullable().defaultTo('partial');
    table.integer('report_seq').notNullable().defaultTo(0);
    // Socket currently driving this session — lets a stale socket's late
    // disconnect not mark a session that a newer socket already resumed.
    table.string('socket_id', 64).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['conversation_id', 'client_session_id']);
    table.index(['conversation_id', 'started_at']);
  });

  await knex.schema.alterTable('conversations', (table) => {
    table.integer('timing_revision').notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.dropColumn('timing_revision');
  });
  await knex.schema.dropTableIfExists('conversation_recording_sessions');
}
