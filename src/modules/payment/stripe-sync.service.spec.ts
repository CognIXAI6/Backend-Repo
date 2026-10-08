import { NotFoundException, BadRequestException } from '@nestjs/common';
import { StripeSyncService } from './stripe-sync.service';

/**
 * Fake knex for subscription_plans, resolving each successive
 * `knex('subscription_plans')` invocation to the next entry in
 * `terminalResults` — same call-indexed style as usage.service.spec.ts.
 */
function createFakeKnex(terminalResults: unknown[]) {
  let callIndex = 0;
  const fakeKnex: any = jest.fn(() => {
    const result = terminalResults[callIndex++];
    const chain: any = {};
    for (const method of ['where', 'whereNotNull', 'whereNot', 'update']) {
      chain[method] = jest.fn(() => chain);
    }
    chain.first = jest.fn().mockResolvedValue(result);
    chain.returning = jest.fn().mockResolvedValue(result);
    return chain;
  });
  return fakeKnex;
}

function createFakeConfig() {
  return { get: jest.fn().mockReturnValue(undefined) } as any;
}

function withFakeStripe(service: StripeSyncService, stripe: Record<string, unknown>) {
  (service as any).stripe = stripe;
  return service;
}

describe('StripeSyncService.publishPlanPrice', () => {
  it('rejects the free plan — nothing to publish', async () => {
    const service = new StripeSyncService(createFakeConfig(), createFakeKnex([{ id: 'p1', plan_type: 'free' }]));
    await expect(service.publishPlanPrice('p1')).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when the plan does not exist', async () => {
    const service = new StripeSyncService(createFakeConfig(), createFakeKnex([undefined]));
    await expect(service.publishPlanPrice('missing')).rejects.toThrow(NotFoundException);
  });

  it('creates a new Product and Price when none exists yet, and writes both IDs back', async () => {
    const plan = {
      id: 'p1', plan_type: 'standard', billing_cycle: 'monthly',
      amount_cents: 845, currency: 'usd', stripe_product_id: null, stripe_price_id: null,
    };
    const fakeKnex = createFakeKnex([
      plan, // where(id).first()
      undefined, // sibling lookup — no existing product for this plan_type
      [{ ...plan, stripe_product_id: 'prod_new', stripe_price_id: 'price_new' }], // update().returning('*')
    ]);
    const stripe = {
      products: { create: jest.fn().mockResolvedValue({ id: 'prod_new' }) },
      prices: { create: jest.fn().mockResolvedValue({ id: 'price_new' }), update: jest.fn() },
    };
    const service = withFakeStripe(new StripeSyncService(createFakeConfig(), fakeKnex), stripe);

    const result = await service.publishPlanPrice('p1');

    expect(stripe.products.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'CognIX Standard', metadata: { planType: 'standard' } }),
    );
    expect(stripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        product: 'prod_new',
        currency: 'usd',
        unit_amount: 845,
        recurring: { interval: 'month', interval_count: 1 },
      }),
    );
    expect(stripe.prices.update).not.toHaveBeenCalled(); // nothing to archive
    expect(result.stripe_price_id).toBe('price_new');
  });

  it('reuses a sibling billing-cycle plan’s Stripe product instead of creating a new one', async () => {
    const plan = {
      id: 'p2', plan_type: 'xpress', billing_cycle: 'yearly',
      amount_cents: 19430, currency: 'usd', stripe_product_id: null, stripe_price_id: null,
    };
    const fakeKnex = createFakeKnex([
      plan,
      { id: 'p1', stripe_product_id: 'prod_xpress' }, // sibling already has a product
      [{ ...plan, stripe_product_id: 'prod_xpress', stripe_price_id: 'price_yearly' }],
    ]);
    const stripe = {
      products: { create: jest.fn() },
      prices: { create: jest.fn().mockResolvedValue({ id: 'price_yearly' }), update: jest.fn() },
    };
    const service = withFakeStripe(new StripeSyncService(createFakeConfig(), fakeKnex), stripe);

    await service.publishPlanPrice('p2');

    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'prod_xpress', recurring: { interval: 'year', interval_count: 1 } }),
    );
  });

  it('archives the previous Price when republishing a changed amount', async () => {
    const plan = {
      id: 'p3', plan_type: 'plus', billing_cycle: 'quarterly',
      amount_cents: 4075, currency: 'usd', stripe_product_id: 'prod_plus', stripe_price_id: 'price_old',
    };
    const fakeKnex = createFakeKnex([
      plan, // has its own product already — no sibling lookup needed
      [{ ...plan, stripe_price_id: 'price_new_q' }],
    ]);
    const stripe = {
      products: { create: jest.fn() },
      prices: {
        create: jest.fn().mockResolvedValue({ id: 'price_new_q' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = withFakeStripe(new StripeSyncService(createFakeConfig(), fakeKnex), stripe);

    await service.publishPlanPrice('p3');

    expect(stripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'prod_plus', recurring: { interval: 'month', interval_count: 3 } }),
    );
    expect(stripe.prices.update).toHaveBeenCalledWith('price_old', { active: false });
  });

  it('does not let a failed archive of the old price block the publish', async () => {
    const plan = {
      id: 'p4', plan_type: 'standard', billing_cycle: 'biannual',
      amount_cents: 4560, currency: 'usd', stripe_product_id: 'prod_standard', stripe_price_id: 'price_old_b',
    };
    const fakeKnex = createFakeKnex([plan, [{ ...plan, stripe_price_id: 'price_new_b' }]]);
    const stripe = {
      products: { create: jest.fn() },
      prices: {
        create: jest.fn().mockResolvedValue({ id: 'price_new_b' }),
        update: jest.fn().mockRejectedValue(new Error('price already archived')),
      },
    };
    const service = withFakeStripe(new StripeSyncService(createFakeConfig(), fakeKnex), stripe);

    const result = await service.publishPlanPrice('p4');

    expect(result.stripe_price_id).toBe('price_new_b');
  });
});
