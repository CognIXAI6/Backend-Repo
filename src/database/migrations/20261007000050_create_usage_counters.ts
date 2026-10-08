import { Knex } from 'knex';

// Per-user, per-calendar-month usage ledger for authenticated users — the
// paid-tier counterpart to guest_sessions' prompt_count/prompt_limit, but
// period-keyed so a new month's row starts at zero on first write with no
// scheduled reset job (see UsageService).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('usage_counters', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    // First-of-month date this row's counters apply to, e.g. 2026-10-01.
    table.date('period_start').notNullable();

    table.integer('messages_used').notNullable().defaultTo(0);
    table.integer('voice_seconds_used').notNullable().defaultTo(0);
    table.integer('documents_used').notNullable().defaultTo(0);
    table.integer('video_analyses_used').notNullable().defaultTo(0);
    table.integer('web_searches_used').notNullable().defaultTo(0);

    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.unique(['user_id', 'period_start']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('usage_counters');
}
