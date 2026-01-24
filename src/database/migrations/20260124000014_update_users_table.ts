import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
   // Add avatar_url to users table
  await knex.schema.alterTable('users', (table) => {
    table.string('avatar_url').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('avatar_url');
  });
}