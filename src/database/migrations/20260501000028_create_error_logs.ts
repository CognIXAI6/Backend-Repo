import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('error_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('source').notNullable();          // e.g. 'voice_gateway', 'claude', 'deepgram'
    table.string('code').notNullable();            // e.g. 'NO_SESSION', 'AI_ERROR'
    table.text('message').notNullable();           // full internal error message
    table.text('stack').nullable();                // stack trace if available
    table.jsonb('context').nullable();             // any extra metadata (userId, socketId, etc.)
    table.string('severity').defaultTo('error');   // 'info' | 'warn' | 'error' | 'critical'
    table.boolean('notified').defaultTo(false);    // true if admin email was sent
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index('source', 'idx_error_logs_source');
    table.index('code', 'idx_error_logs_code');
    table.index('severity', 'idx_error_logs_severity');
    table.index('created_at', 'idx_error_logs_created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('error_logs');
}
