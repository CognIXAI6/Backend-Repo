import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    // Atomic per-conversation counter, claimed via
    // `UPDATE conversations SET next_message_sequence = next_message_sequence + 1 ...`
    // inside the same transaction as a message insert.
    table.bigInteger('next_message_sequence').notNullable().defaultTo(0);
  });

  await knex.schema.alterTable('conversation_messages', (table) => {
    // NULL for every pre-existing row and for anything saved through the
    // voice path that doesn't supply one — only rows submitted through the
    // durable chat command path set this.
    table.uuid('client_message_id').nullable();
    // NULL for historical rows (never backfilled) — only newly-inserted
    // rows get a sequence assigned by saveMessage().
    table.bigInteger('conversation_sequence').nullable();
    table.text('delivery_source').notNullable().defaultTo('voice');

    // Postgres treats NULL as distinct for uniqueness purposes, so this
    // only constrains rows that actually set a client_message_id.
    table.unique(['conversation_id', 'client_message_id']);
  });

  await knex.schema.raw(`
    CREATE INDEX idx_conversation_messages_conversation_sequence
    ON conversation_messages (conversation_id, conversation_sequence);
  `);

  await knex.schema.raw(`
    ALTER TABLE conversation_messages
    ADD CONSTRAINT chk_conversation_messages_delivery_source
    CHECK (delivery_source IN ('text', 'voice', 'attachment', 'regenerate'));
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    ALTER TABLE conversation_messages DROP CONSTRAINT IF EXISTS chk_conversation_messages_delivery_source;
  `);
  await knex.schema.raw(`DROP INDEX IF EXISTS idx_conversation_messages_conversation_sequence;`);
  await knex.schema.alterTable('conversation_messages', (table) => {
    table.dropUnique(['conversation_id', 'client_message_id']);
    table.dropColumn('delivery_source');
    table.dropColumn('conversation_sequence');
    table.dropColumn('client_message_id');
  });
  await knex.schema.alterTable('conversations', (table) => {
    table.dropColumn('next_message_sequence');
  });
}
