import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscription_plans', (table) => {
    table.dropColumn('stripe_price_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscription_plans', (table) => {
    table.string('stripe_price_id', 255).nullable();
  });
}
