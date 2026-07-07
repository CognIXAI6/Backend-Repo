import { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  await knex('subscription_plans').del();

  await knex('subscription_plans').insert([
    {
      billing_cycle: 'monthly',
      amount_cents: 800,
      currency: 'usd',
      label: 'Monthly',
      discount_percent: 0,
      is_active: true,
    },
    {
      billing_cycle: 'quarterly',
      amount_cents: 2200,
      currency: 'usd',
      label: '3 Months',
      discount_percent: 8,
      is_active: true,
    },
    {
      billing_cycle: 'biannual',
      amount_cents: 4100,
      currency: 'usd',
      label: '6 Months',
      discount_percent: 15,
      is_active: true,
    },
    {
      billing_cycle: 'yearly',
      amount_cents: 7700,
      currency: 'usd',
      label: 'Yearly',
      discount_percent: 20,
      is_active: true,
    },
  ]);
}
