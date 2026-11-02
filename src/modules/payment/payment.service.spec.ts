import { PaymentService } from './payment.service';

function createFakeKnex(opts: {
  userByCustomerId?: any;
  userByMetadataId?: any;
  planForPriceId?: any;
}) {
  const updateCalls: Array<{ table: string; where: [string, any]; data: any }> = [];
  const insertCalls: Array<{ table: string; data: any }> = [];

  function makeUsersChain() {
    let lastWhere: [string, any] = ['', undefined];
    const chain: any = {
      where: jest.fn((col: string, val: any) => {
        lastWhere = [col, val];
        return chain;
      }),
      first: jest.fn(() => {
        if (lastWhere[0] === 'stripe_customer_id') return Promise.resolve(opts.userByCustomerId);
        if (lastWhere[0] === 'id') return Promise.resolve(opts.userByMetadataId);
        return Promise.resolve(undefined);
      }),
      update: jest.fn((data: any) => {
        updateCalls.push({ table: 'users', where: lastWhere, data });
        return Promise.resolve(1);
      }),
    };
    return chain;
  }

  function makeSubscriptionPlansChain() {
    const chain: any = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(opts.planForPriceId ?? null),
    };
    return chain;
  }

  function makeSubscriptionsChain() {
    const chain: any = {
      insert: jest.fn((data: any) => {
        insertCalls.push({ table: 'subscriptions', data });
        return chain;
      }),
      onConflict: jest.fn().mockReturnThis(),
      merge: jest.fn().mockResolvedValue(undefined),
    };
    return chain;
  }

  const knexLike: any = jest.fn((table: string) => {
    if (table === 'users') return makeUsersChain();
    if (table === 'subscription_plans') return makeSubscriptionPlansChain();
    if (table === 'subscriptions') return makeSubscriptionsChain();
    throw new Error(`unexpected table: ${table}`);
  });

  return { knexLike, updateCalls, insertCalls };
}

function createService(knexLike: any) {
  const configService = { get: jest.fn().mockReturnValue(undefined) } as any;
  return new PaymentService(
    configService,
    knexLike,
    {} as any, // geoService
    {} as any, // fxService
    {} as any, // flutterwaveService
    {} as any, // entitlementsService
    {} as any, // usageService
  ) as any;
}

function fakeStripeSubscription(overrides: Partial<any> = {}) {
  return {
    id: 'sub_123',
    customer: 'cus_unknown',
    status: 'active',
    items: { data: [{ price: { id: 'price_123' } }] },
    current_period_start: 1700000000,
    current_period_end: 1702592000,
    metadata: { userId: 'user-1', planType: 'standard' },
    ...overrides,
  };
}

describe('PaymentService.syncSubscription — metadata.userId fallback', () => {
  it('activates the subscription via subscription.metadata.userId when stripe_customer_id has no match, and backfills it', async () => {
    const { knexLike, updateCalls } = createFakeKnex({
      userByCustomerId: undefined,
      userByMetadataId: { id: 'user-1', email: 'user@example.com', stripe_customer_id: null },
    });
    const service = createService(knexLike);

    await service.syncSubscription(fakeStripeSubscription());

    // Backfill: stripe_customer_id written onto the recovered user.
    const backfill = updateCalls.find((c) => c.data.stripe_customer_id === 'cus_unknown');
    expect(backfill).toBeTruthy();

    // Tier activation still happens for the recovered user.
    const tierUpdate = updateCalls.find((c) => c.data.subscription_tier === 'standard');
    expect(tierUpdate).toBeTruthy();
  });

  it('still no-ops (no crash, no write) when neither stripe_customer_id nor metadata.userId resolve a user', async () => {
    const { knexLike, updateCalls } = createFakeKnex({
      userByCustomerId: undefined,
      userByMetadataId: undefined,
    });
    const service = createService(knexLike);

    await service.syncSubscription(fakeStripeSubscription({ metadata: {} }));

    expect(updateCalls).toHaveLength(0);
  });

  it('uses the stripe_customer_id match directly when it succeeds, without touching the metadata fallback', async () => {
    const { knexLike, updateCalls } = createFakeKnex({
      userByCustomerId: { id: 'user-2', email: 'direct@example.com', stripe_customer_id: 'cus_unknown' },
    });
    const service = createService(knexLike);

    await service.syncSubscription(fakeStripeSubscription());

    const backfill = updateCalls.find((c) => c.data.stripe_customer_id);
    expect(backfill).toBeUndefined(); // no backfill needed — already matched directly
    const tierUpdate = updateCalls.find((c) => c.data.subscription_tier === 'standard');
    expect(tierUpdate).toBeTruthy();
  });
});
