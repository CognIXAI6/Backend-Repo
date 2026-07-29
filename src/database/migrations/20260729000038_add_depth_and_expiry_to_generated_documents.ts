import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('generated_documents', (table) => {
    table.string('depth').notNullable().defaultTo('standard');
    table.string('format').notNullable().defaultTo('docx');
    // Soft-expiry: null means no expiry. Clients can filter or auto-delete past this date.
    table.timestamp('expires_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('generated_documents', (table) => {
    table.dropColumn('depth');
    table.dropColumn('format');
    table.dropColumn('expires_at');
  });
}
