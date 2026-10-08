import { Knex } from 'knex';

// Figures taken verbatim from CognIX_AI_Subscription_Pricing.md — the
// founder-approved final pricing doc. Each tier keeps its own discount
// curve (Standard/Plus/Xpress differ), so discount_percent is stored
// per-row rather than derived.
export async function seed(knex: Knex): Promise<void> {
  await knex('subscription_plans').del();

  await knex('subscription_plans').insert([
    // ── Free ────────────────────────────────────────────────────────────────
    {
      plan_type: 'free',
      billing_cycle: 'monthly',
      amount_cents: 0,
      currency: 'usd',
      label: 'Free',
      discount_percent: 0,
      is_active: true,
    },

    // ── Standard ($8.45/mo) ────────────────────────────────────────────────
    {
      plan_type: 'standard',
      billing_cycle: 'monthly',
      amount_cents: 845,
      currency: 'usd',
      label: 'Standard — Monthly',
      discount_percent: 0,
      is_active: true,
    },
    {
      plan_type: 'standard',
      billing_cycle: 'quarterly',
      amount_cents: 2400,
      currency: 'usd',
      label: 'Standard — 3 Months',
      discount_percent: 5.3,
      is_active: true,
    },
    {
      plan_type: 'standard',
      billing_cycle: 'biannual',
      amount_cents: 4560,
      currency: 'usd',
      label: 'Standard — 6 Months',
      discount_percent: 10,
      is_active: true,
    },
    {
      plan_type: 'standard',
      billing_cycle: 'yearly',
      amount_cents: 8450,
      currency: 'usd',
      label: 'Standard — Yearly',
      discount_percent: 16.7,
      is_active: true,
    },

    // ── Plus ($14.45/mo) ───────────────────────────────────────────────────
    {
      plan_type: 'plus',
      billing_cycle: 'monthly',
      amount_cents: 1445,
      currency: 'usd',
      label: 'Plus — Monthly',
      discount_percent: 0,
      is_active: true,
    },
    {
      plan_type: 'plus',
      billing_cycle: 'quarterly',
      amount_cents: 4075,
      currency: 'usd',
      label: 'Plus — 3 Months',
      discount_percent: 6,
      is_active: true,
    },
    {
      plan_type: 'plus',
      billing_cycle: 'biannual',
      amount_cents: 7803,
      currency: 'usd',
      label: 'Plus — 6 Months',
      discount_percent: 10,
      is_active: true,
    },
    {
      plan_type: 'plus',
      billing_cycle: 'yearly',
      amount_cents: 14739,
      currency: 'usd',
      label: 'Plus — Yearly',
      discount_percent: 15,
      is_active: true,
    },

    // ── Xpress ($19.99/mo) ─────────────────────────────────────────────────
    {
      plan_type: 'xpress',
      billing_cycle: 'monthly',
      amount_cents: 1999,
      currency: 'usd',
      label: 'Xpress — Monthly',
      discount_percent: 0,
      is_active: true,
    },
    {
      plan_type: 'xpress',
      billing_cycle: 'quarterly',
      amount_cents: 5580,
      currency: 'usd',
      label: 'Xpress — 3 Months',
      discount_percent: 7,
      is_active: true,
    },
    {
      plan_type: 'xpress',
      billing_cycle: 'biannual',
      amount_cents: 10555,
      currency: 'usd',
      label: 'Xpress — 6 Months',
      discount_percent: 12,
      is_active: true,
    },
    {
      plan_type: 'xpress',
      billing_cycle: 'yearly',
      amount_cents: 19430,
      currency: 'usd',
      label: 'Xpress — Yearly',
      discount_percent: 19,
      is_active: true,
    },
  ]);
}
