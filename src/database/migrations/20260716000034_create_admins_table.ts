import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('admins', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email', 255).unique().notNullable();
    table.string('name', 255).notNullable();
    table.string('password_hash', 255).notNullable();
    table.enum('role', ['super_admin', 'admin']).notNullable().defaultTo('admin');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.uuid('invited_by').nullable().references('id').inTable('admins').onDelete('SET NULL');
    table.timestamp('last_login_at').nullable();
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('admins');
}
