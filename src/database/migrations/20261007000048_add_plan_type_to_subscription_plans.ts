import { Knex } from 'knex';

// Introduces the tier dimension subscription_plans was missing — until now a
// row was identified only by billing_cycle, implying a single paid plan.
// Three paid tiers (standard/plus/xpress) plus a free tier now coexist, each
// priceable per billing cycle, so the unique key becomes (plan_type, billing_cycle).
//
// stripe_price_id is re-added (dropped in migration 032, when the project
// moved to env-var-only price IDs to avoid DB/env drift from ad-hoc manual
// edits). It's safe to source from the DB again now that a single controlled
// admin "publish" action (see StripeSyncService) owns writes to this column —
// see payment.service.ts for the corresponding read-path change.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscription_plans', (table) => {
    table.string('plan_type', 20).notNullable().defaultTo('standard');
    table.string('stripe_product_id', 255).nullable();
    table.string('stripe_price_id', 255).nullable();
  });

  // The approved pricing doc uses fractional discounts (Standard quarterly is
  // 5.3%, not 5%) — the original integer column couldn't represent that
  // without rounding away the real figure.
  await knex.raw(`ALTER TABLE subscription_plans ALTER COLUMN discount_percent TYPE decimal(5,2)`);

  await knex.schema.alterTable('subscription_plans', (table) => {
    table.dropUnique(['billing_cycle']);
    table.unique(['plan_type', 'billing_cycle']);
  });

  await knex.raw(`
    ALTER TABLE subscription_plans
    ADD CONSTRAINT subscription_plans_plan_type_check
    CHECK (plan_type IN ('free', 'standard', 'plus', 'xpress'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE subscription_plans ALTER COLUMN discount_percent TYPE integer USING round(discount_percent)`);

  await knex.raw(`ALTER TABLE subscription_plans DROP CONSTRAINT IF EXISTS subscription_plans_plan_type_check`);

  await knex.schema.alterTable('subscription_plans', (table) => {
    table.dropUnique(['plan_type', 'billing_cycle']);
  });

  await knex.schema.alterTable('subscription_plans', (table) => {
    table.dropColumn('plan_type');
    table.dropColumn('stripe_product_id');
    table.dropColumn('stripe_price_id');
  });

  await knex.schema.alterTable('subscription_plans', (table) => {
    table.unique(['billing_cycle']);
  });
}
