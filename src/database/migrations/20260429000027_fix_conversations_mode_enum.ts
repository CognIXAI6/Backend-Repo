import { Knex } from 'knex';

/**
 * The original conversations.mode column was an enum(['single','double','multi']).
 * This migration converts it to plain TEXT so new modes (dual_speaker, etc.)
 * can be added without further schema changes. The application layer enforces
 * the allowed values via TypeScript types.
 */
export async function up(knex: Knex): Promise<void> {
  // Drop the enum check constraint and convert column to TEXT
  await knex.raw(`ALTER TABLE conversations ALTER COLUMN mode TYPE TEXT USING mode::TEXT`);

  // Ensure total_messages has a proper default (guard against any old null rows)
  await knex.raw(`
    UPDATE conversations SET total_messages = 0 WHERE total_messages IS NULL
  `);
  await knex.raw(`
    ALTER TABLE conversations ALTER COLUMN total_messages SET DEFAULT 0,
                                ALTER COLUMN total_messages SET NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Revert dual_speaker rows to 'single' so the re-applied enum doesn't reject them
  await knex('conversations').where('mode', 'dual_speaker').update({ mode: 'single' });

  await knex.raw(`
    ALTER TABLE conversations
    ALTER COLUMN mode TYPE TEXT USING mode::TEXT
  `);
}
