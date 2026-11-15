import { Knex } from 'knex';

/**
 * Coarse outcome of the auto-summary email, per conversation (the latest attempt).
 *
 * Deliberately minimal: no recipient, no provider response, no message content.
 * `accepted_by_provider` means the email provider accepted the message for delivery —
 * NOT that it reached an inbox. Legacy rows stay NULL, which the API reports as
 * "unknown". The email outcome never affects `summary_status` (summary readiness).
 *
 * Additive and nullable: apply BEFORE deploying code that writes these columns. Rolling
 * the application back needs no schema change — the prior version simply ignores them.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    // pending | accepted_by_provider | failed | skipped
    table.string('summary_email_status', 24).nullable();
    // coarse reason code (see summary-email-status.util.ts), never provider text
    table.string('summary_email_reason', 32).nullable();
    table.timestamp('summary_email_updated_at', { useTz: true }).nullable();
    // The summary document this outcome is about, so a client can tell if it is current.
    table
      .uuid('summary_email_document_id')
      .nullable()
      .references('id')
      .inTable('generated_documents')
      .onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.dropColumn('summary_email_document_id');
    table.dropColumn('summary_email_updated_at');
    table.dropColumn('summary_email_reason');
    table.dropColumn('summary_email_status');
  });
}
