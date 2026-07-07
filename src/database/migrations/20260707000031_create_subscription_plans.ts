import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('subscription_plans', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('billing_cycle', 20).unique().notNullable();
    table.string('stripe_price_id', 255).nullable();
    table.integer('amount_cents').notNullable();
    table.string('currency', 3).notNullable().defaultTo('usd');
    table.string('label', 100).notNullable();
    table.integer('discount_percent').notNullable().defaultTo(0);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('subscription_plans');
}
