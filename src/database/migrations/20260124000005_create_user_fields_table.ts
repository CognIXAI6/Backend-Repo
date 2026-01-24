import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // User fields (many-to-many with additional data)
  await knex.schema.createTable('user_fields', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.uuid('field_id').references('id').inTable('fields').onDelete('CASCADE');
    table.boolean('is_primary').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.unique(['user_id', 'field_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_fields');
}
