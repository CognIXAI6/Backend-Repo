import { Knex } from 'knex';

/**
 * No active Flutterwave account right now — this flag lets payment.service.ts
 * force every checkout/pricing lookup to Stripe regardless of detected
 * country, and lets an admin flip Flutterwave back on later without a
 * deploy once the account is restored.
 */
export async function up(knex: Knex): Promise<void> {
  await knex('app_settings')
    .insert({
      key: 'flutterwave_enabled',
      value: JSON.stringify(false),
      description: 'When false, all payments route through Stripe regardless of detected country (Flutterwave account inactive).',
    })
    .onConflict('key')
    .merge();
}

export async function down(knex: Knex): Promise<void> {
  await knex('app_settings').where('key', 'flutterwave_enabled').del();
}
