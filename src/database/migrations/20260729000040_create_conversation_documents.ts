import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversation_documents', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('filename').notNullable();
    table.string('mime_type').notNullable();
    table.text('file_url').nullable();
    // Full extracted text converted to Markdown format.
    table.text('content_markdown').notNullable();
    table.integer('char_count').defaultTo(0);
    table.timestamps(true, true);
  });

  await knex.schema.alterTable('conversation_documents', (table) => {
    table.index('conversation_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversation_documents');
}
