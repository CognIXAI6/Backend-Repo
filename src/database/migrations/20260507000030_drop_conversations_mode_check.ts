import type { Knex } from 'knex';

/**
 * Migration 20260429000027 converted conversations.mode from a Knex enum to TEXT,
 * but ALTER COLUMN TYPE does not remove a CHECK constraint. The original
 * table.enum() call produced a PostgreSQL CHECK constraint named
 * "conversations_mode_check" that still rejects any value outside
 * ['single', 'double', 'multi']. This migration drops that constraint so
 * values like 'dual_speaker' are accepted.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE conversations
    DROP CONSTRAINT IF EXISTS conversations_mode_check
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE conversations
    ADD CONSTRAINT conversations_mode_check
    CHECK (mode IN ('single', 'double', 'multi', 'dual_speaker'))
  `);
}
