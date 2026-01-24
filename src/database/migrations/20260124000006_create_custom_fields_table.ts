import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Custom fields created by users
  await knex.schema.createTable('custom_fields', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.string('name').notNullable();
    table.string('description').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('custom_fields');
}
