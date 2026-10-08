import { Knex } from 'knex';

// Denormalized alongside the existing billing_cycle column. Every row that
// already exists predates the multi-tier change and was always for the one
// paid plan that existed at the time — which is what 'standard' now is — so
// backfilling to 'standard' preserves exactly what those subscribers are
// already paying for (see migration 052 for the matching users.subscription_tier backfill).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscriptions', (table) => {
    table.string('plan_type', 20).nullable();
  });

  await knex('subscriptions').update({ plan_type: 'standard' });

  await knex.raw(`
    ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_plan_type_check
    CHECK (plan_type IS NULL OR plan_type IN ('free', 'standard', 'plus', 'xpress'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_type_check`);
  await knex.schema.alterTable('subscriptions', (table) => {
    table.dropColumn('plan_type');
  });
}
