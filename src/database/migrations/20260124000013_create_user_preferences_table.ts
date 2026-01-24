import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // User preferences table (AI Behaviour settings)
  await knex.schema.createTable('user_preferences', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE').unique();
    table.enum('response_length', ['concise', 'balanced', 'detailed']).defaultTo('balanced');
    table.enum('tone', ['professional', 'friendly', 'direct']).defaultTo('professional');
    table.string('language').defaultTo('en');
    table.jsonb('custom_instructions').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_preferences');
}