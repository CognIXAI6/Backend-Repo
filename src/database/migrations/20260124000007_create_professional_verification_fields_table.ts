import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    // Professional verifications (for Healthcare, Law, etc.)
  await knex.schema.createTable('professional_verifications', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.uuid('field_id').references('id').inTable('fields').onDelete('CASCADE');
    table.string('full_name').notNullable();
    table.string('country').notNullable();
    table.string('state_province').nullable();
    table.string('specialty').nullable(); // Medical specialty or legal practice type
    table.string('license_type').nullable();
    table.integer('years_of_experience').nullable();
    table.string('license_document_url').nullable();
    table.enum('status', ['pending', 'approved', 'rejected']).defaultTo('pending');
    table.text('rejection_reason').nullable();
    table.timestamp('reviewed_at').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('professional_verifications');
}
