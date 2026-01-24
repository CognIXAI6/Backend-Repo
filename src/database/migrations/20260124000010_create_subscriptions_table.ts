import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Subscriptions
  await knex.schema.createTable('subscriptions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.string('stripe_subscription_id').unique().nullable();
    table.string('stripe_price_id').nullable();
    table.enum('billing_cycle', ['monthly', 'quarterly', 'biannual', 'yearly']).nullable();
    table.enum('status', ['active', 'canceled', 'past_due', 'trialing']).defaultTo('active');
    table.timestamp('current_period_start').nullable();
    table.timestamp('current_period_end').nullable();
    table.timestamp('canceled_at').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('subscriptions');
}
