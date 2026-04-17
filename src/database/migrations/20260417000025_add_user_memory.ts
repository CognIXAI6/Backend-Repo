import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    // Persistent AI memory summary — updated after each session ends
    table.text('ai_memory').nullable().defaultTo(null);
    table.timestamp('ai_memory_updated_at').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('ai_memory');
    table.dropColumn('ai_memory_updated_at');
  });
}
