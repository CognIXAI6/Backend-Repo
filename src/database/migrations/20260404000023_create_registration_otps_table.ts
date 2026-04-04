import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('registration_otps', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Email address this OTP was sent to (no user yet at this stage)
    table.string('email').notNullable().index();
    // Bcrypt-hashed OTP code
    table.string('token').notNullable();
    // Optional niche/field captured before OTP was sent
    table.uuid('niche_id').nullable().references('id').inTable('fields').onDelete('SET NULL');
    table.timestamp('expires_at').notNullable();
    table.boolean('used').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('registration_otps');
}
