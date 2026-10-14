import { Knex } from 'knex';

/**
 * Lets an admin grant a paid tier to a test/beta account without a real
 * Stripe/Flutterwave subscription. Distinguishing these rows from real
 * provider subscriptions matters because admin.service.ts's revenue
 * analytics and provider-detection logic (LIKE 'flw-%' on
 * stripe_subscription_id) should never count an admin grant as revenue.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscriptions', (table) => {
    table.uuid('granted_by_admin_id').nullable().references('id').inTable('admins').onDelete('SET NULL');
    table.boolean('is_admin_grant').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscriptions', (table) => {
    table.dropColumn('granted_by_admin_id');
    table.dropColumn('is_admin_grant');
  });
}
