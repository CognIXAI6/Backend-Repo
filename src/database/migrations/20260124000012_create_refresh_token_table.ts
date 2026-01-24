import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
   // Refresh tokens
  await knex.schema.createTable('refresh_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.string('token').unique().notNullable();
    table.timestamp('expires_at').notNullable();
    table.boolean('revoked').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('refresh_tokens');
}
