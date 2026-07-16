import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('subscription_plan_prices', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('plan_id').notNullable().references('id').inTable('subscription_plans').onDelete('CASCADE');
    // ISO 4217 currency code: NGN, GHS, KES, ZAR, USD, GBP …
    table.string('currency', 3).notNullable();
    // When set, this amount is used instead of the live FX-computed amount.
    // Stored in the currency's minor unit (kobo for NGN, cents for USD, etc.).
    table.integer('amount_override_cents').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamps(true, true);
    table.unique(['plan_id', 'currency']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('subscription_plan_prices');
}
