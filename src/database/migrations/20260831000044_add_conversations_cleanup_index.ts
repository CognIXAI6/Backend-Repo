import { Knex } from 'knex';

// CREATE INDEX CONCURRENTLY is not allowed inside a transaction in
// Postgres — Knex wraps every migration in one by default, so this must be
// disabled here or the migration fails outright.
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_cleanup_candidates
    ON conversations (created_at)
    WHERE deleted_at IS NULL AND total_messages = 0;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_conversations_cleanup_candidates;`);
}
