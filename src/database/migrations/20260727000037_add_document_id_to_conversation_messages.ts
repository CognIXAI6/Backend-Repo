import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_messages', (table) => {
    table
      .uuid('document_id')
      .nullable()
      .references('id')
      .inTable('generated_documents')
      .onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversation_messages', (table) => {
    table.dropColumn('document_id');
  });
}
