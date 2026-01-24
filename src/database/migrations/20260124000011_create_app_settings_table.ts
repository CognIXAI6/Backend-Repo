import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // App settings (for dynamic configuration)
  await knex.schema.createTable('app_settings', (table) => {
    table.string('key').primary();
    table.jsonb('value').notNullable();
    table.string('description').nullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_settings');
}
