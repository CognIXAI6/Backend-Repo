import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('admin_invitations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email', 255).notNullable();
    table.string('name', 255).notNullable();
    table.string('token', 255).unique().notNullable();
    table.uuid('invited_by').notNullable().references('id').inTable('admins').onDelete('CASCADE');
    table.enum('role', ['super_admin', 'admin']).notNullable().defaultTo('admin');
    table.timestamp('expires_at').notNullable();
    table.timestamp('accepted_at').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('admin_invitations');
}
