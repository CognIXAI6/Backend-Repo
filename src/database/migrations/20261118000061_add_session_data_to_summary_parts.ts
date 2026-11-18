import { Knex } from 'knex';

/**
 * Structured content of each summarised session (summary, speaker-by-speaker transcript with the AI's
 * insights, key insights, action points), so a conversation's document can be re-rendered as one clean
 * section per session without re-reading or re-summarising old messages.
 *
 * Additive and nullable: existing parts keep rendering from their `sections`. Apply BEFORE deploying code
 * that writes it; rolling the application back needs no schema change (the old code ignores the column).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_summary_parts', (table) => {
    table.jsonb('session_data').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_summary_parts', (table) => {
    table.dropColumn('session_data');
  });
}
