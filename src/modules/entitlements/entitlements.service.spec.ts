import { EntitlementsService } from './entitlements.service';
import { FREE_FALLBACK_ENTITLEMENTS } from './entitlements.types';

function createFakeKnex(responses: Record<string, (table: string, args: unknown[]) => unknown>) {
  const calls: Array<{ table: string; args: unknown[] }> = [];

  const fakeKnex: any = jest.fn((table: string) => {
    const chain: any = {};
    const args: unknown[] = [];
    for (const method of ['where', 'whereIn', 'first']) {
      chain[method] = jest.fn((...a: unknown[]) => {
        args.push({ method, a });
        return chain;
      });
    }
    // `first('subscription_tier')` and the final `.first()`/`.whereIn().first()`
    // in these code paths are the terminal call — resolve once the chain is built.
    const resolve = () => {
      calls.push({ table, args });
      const handler = responses[table];
      return handler ? handler(table, args) : undefined;
    };
    chain.first = jest.fn((...a: unknown[]) => {
      args.push({ method: 'first', a });
      return Promise.resolve(resolve());
    });
    return chain;
  });

  return { fakeKnex, calls };
}

describe('EntitlementsService', () => {
  describe('getEntitlementsForTier', () => {
    it('maps a plan_entitlements row to the camelCase shape the app reads', async () => {
      const { fakeKnex } = createFakeKnex({
        plan_entitlements: () => ({
          plan_type: 'standard',
          max_messages_per_month: 500,
          max_voice_minutes_per_month: 300,
          allowed_voice_modes: ['single', 'dual_speaker'],
          max_documents_per_month: 10,
          allowed_document_depths: ['brief', 'standard'],
          max_video_analyses_per_month: 2,
          max_video_minutes_per_analysis: 15,
          max_web_searches_per_month: null,
          support_tier: 'standard_24h',
          priority_memory: false,
        }),
      });
      const service = new EntitlementsService(fakeKnex);

      const entitlements = await service.getEntitlementsForTier('standard');

      expect(entitlements).toEqual({
        planType: 'standard',
        maxMessagesPerMonth: 500,
        maxVoiceMinutesPerMonth: 300,
        allowedVoiceModes: ['single', 'dual_speaker'],
        maxDocumentsPerMonth: 10,
        allowedDocumentDepths: ['brief', 'standard'],
        maxVideoAnalysesPerMonth: 2,
        maxVideoMinutesPerAnalysis: 15,
        maxWebSearchesPerMonth: null,
        supportTier: 'standard_24h',
        priorityMemory: false,
      });
    });

    it('fails closed to Free-level limits when a plan_type has no entitlements row', async () => {
      const { fakeKnex } = createFakeKnex({ plan_entitlements: () => undefined });
      const service = new EntitlementsService(fakeKnex);

      const entitlements = await service.getEntitlementsForTier('xpress');

      expect(entitlements).toEqual({ ...FREE_FALLBACK_ENTITLEMENTS, planType: 'xpress' });
    });

    it('caches a resolved tier so a second call within the TTL skips the DB', async () => {
      const { fakeKnex, calls } = createFakeKnex({
        plan_entitlements: () => ({
          plan_type: 'plus',
          max_messages_per_month: 500,
          max_voice_minutes_per_month: 600,
          allowed_voice_modes: ['single', 'dual_speaker'],
          max_documents_per_month: 25,
          allowed_document_depths: ['brief', 'standard'],
          max_video_analyses_per_month: 5,
          max_video_minutes_per_analysis: 30,
          max_web_searches_per_month: null,
          support_tier: 'standard_24h',
          priority_memory: false,
        }),
      });
      const service = new EntitlementsService(fakeKnex);

      await service.getEntitlementsForTier('plus');
      await service.getEntitlementsForTier('plus');

      expect(calls).toHaveLength(1);
    });

    it('invalidate() forces the next read to hit the DB again', async () => {
      const { fakeKnex, calls } = createFakeKnex({
        plan_entitlements: () => ({
          plan_type: 'plus',
          max_messages_per_month: 500,
          max_voice_minutes_per_month: 600,
          allowed_voice_modes: ['single'],
          max_documents_per_month: 25,
          allowed_document_depths: [],
          max_video_analyses_per_month: 5,
          max_video_minutes_per_analysis: 30,
          max_web_searches_per_month: null,
          support_tier: 'standard_24h',
          priority_memory: false,
        }),
      });
      const service = new EntitlementsService(fakeKnex);

      await service.getEntitlementsForTier('plus');
      service.invalidate('plus');
      await service.getEntitlementsForTier('plus');

      expect(calls).toHaveLength(2);
    });
  });

  describe('resolveUserTier', () => {
    it('returns free for a user with no row at all', async () => {
      const { fakeKnex } = createFakeKnex({ users: () => undefined });
      const service = new EntitlementsService(fakeKnex);

      expect(await service.resolveUserTier('ghost-user')).toBe('free');
    });

    it('returns free immediately for a free-tier user without checking subscriptions', async () => {
      const { fakeKnex, calls } = createFakeKnex({
        users: () => ({ subscription_tier: 'free' }),
      });
      const service = new EntitlementsService(fakeKnex);

      expect(await service.resolveUserTier('user-1')).toBe('free');
      expect(calls.map((c) => c.table)).toEqual(['users']);
    });

    it('honours a paid tier when a matching active subscription exists', async () => {
      const { fakeKnex } = createFakeKnex({
        users: () => ({ subscription_tier: 'xpress' }),
        subscriptions: () => ({ id: 'sub-1', status: 'active' }),
      });
      const service = new EntitlementsService(fakeKnex);

      expect(await service.resolveUserTier('user-1')).toBe('xpress');
    });

    it('falls back to free when subscription_tier says paid but no active subscription row exists', async () => {
      const { fakeKnex } = createFakeKnex({
        users: () => ({ subscription_tier: 'standard' }),
        subscriptions: () => undefined,
      });
      const service = new EntitlementsService(fakeKnex);

      expect(await service.resolveUserTier('user-1')).toBe('free');
    });
  });
});
