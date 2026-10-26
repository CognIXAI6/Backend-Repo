import { Knex } from 'knex';

/**
 * Auto-generated conversation summaries (voice.gateway.ts's
 * autoGenerateConversationSummary) previously had no persisted state: a
 * silent skip (quota, too-short, entitlement) and a successful generation
 * whose completion event arrived after the client had already disconnected
 * looked identical to the client — nothing. These columns give a client a
 * real, pollable status instead of guessing from a live socket event that
 * frequently arrives too late to be delivered.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table
      .enum('summary_status', ['not_started', 'pending', 'ready', 'failed', 'skipped'])
      .notNullable()
      .defaultTo('not_started');
    table.string('summary_skip_reason', 255).nullable();
    table
      .uuid('summary_document_id')
      .nullable()
      .references('id')
      .inTable('generated_documents')
      .onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.dropColumn('summary_status');
    table.dropColumn('summary_skip_reason');
    table.dropColumn('summary_document_id');
  });
}
