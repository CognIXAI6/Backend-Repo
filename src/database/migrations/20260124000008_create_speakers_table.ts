import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
   // Speakers
  await knex.schema.createTable('speakers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.string('name').notNullable();
    table.string('avatar_url').nullable();
    table.boolean('is_owner').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('speakers');
}
