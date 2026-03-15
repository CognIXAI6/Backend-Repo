import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().index();
    table.string('title', 255).nullable();
    table.enum('mode', ['single', 'double', 'multi']).notNullable().defaultTo('single');
    table.uuid('field_id').nullable().comment('Professional field context');
    table.integer('total_messages').notNullable().defaultTo(0);
    table.timestamp('last_activity_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
 
    table.index('created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversations');
}