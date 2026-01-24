import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
 // Fields (professional domains)
  await knex.schema.createTable('fields', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').unique().notNullable();
    table.string('slug').unique().notNullable();
    table.string('description').nullable();
    table.string('icon').nullable();
    table.boolean('requires_verification').defaultTo(false);
    table.boolean('is_system').defaultTo(true); // System fields can't be deleted
    table.boolean('is_free').defaultTo(false); // Free tier eligibility
    table.boolean('is_active').defaultTo(true);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('fields');
}
