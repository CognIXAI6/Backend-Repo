import { UsageService } from './usage.service';

/**
 * Fake knex tailored to usage_counters' exact query shapes. Each call to
 * `knex('usage_counters')` returns a fresh chainable builder whose terminal
 * method (`ignore` / `first` / `returning`) resolves to the next value in
 * `terminalResults`, in call order — mirrors the manual-knex-mock style
 * already used in chat-message.service.spec.ts.
 */
function createFakeKnex(terminalResults: unknown[]) {
  let callIndex = 0;
  const calls: Array<{ table: string; methodCalls: Record<string, unknown[]> }> = [];

  const fakeKnex: any = jest.fn((table: string) => {
    const record = { table, methodCalls: {} as Record<string, unknown[]> };
    calls.push(record);
    const result = terminalResults[callIndex++];

    const chain: any = {};
    for (const method of ['insert', 'onConflict', 'where', 'andWhere', 'update']) {
      chain[method] = jest.fn((...args: unknown[]) => {
        record.methodCalls[method] = args;
        return chain;
      });
    }
    chain.ignore = jest.fn().mockResolvedValue(result);
    chain.first = jest.fn().mockResolvedValue(result);
    chain.returning = jest.fn().mockResolvedValue(result);
    return chain;
  });

  fakeKnex.raw = jest.fn((sql: string, bindings?: unknown[]) => ({ __raw: sql, bindings }));

  return { fakeKnex, calls };
}

describe('UsageService', () => {
  describe('getStatus', () => {
    it('reports used/remaining/canUse without writing, and creates the period row idempotently', async () => {
      const { fakeKnex, calls } = createFakeKnex([
        undefined, // findOrCreateRow: insert ... onConflict ... ignore()
        { documents_used: 7 }, // findOrCreateRow: where(...).first()
      ]);
      const service = new UsageService(fakeKnex);

      const status = await service.getStatus('user-1', 'documents', 10);

      expect(status).toEqual({ used: 7, limit: 10, remaining: 3, canUse: true });
      expect(calls[0].methodCalls.onConflict).toEqual([['user_id', 'period_start']]);
      expect(calls[0].methodCalls.insert[0]).toEqual(expect.objectContaining({ user_id: 'user-1' }));
    });

    it('treats limit=null as unlimited — canUse true, remaining null', async () => {
      const { fakeKnex } = createFakeKnex([undefined, { web_searches_used: 999 }]);
      const service = new UsageService(fakeKnex);

      const status = await service.getStatus('user-1', 'web_searches', null);

      expect(status).toEqual({ used: 999, limit: null, remaining: null, canUse: true });
    });
  });

  describe('tryConsume', () => {
    it('increments unconditionally when limit is null, still tracking the count', async () => {
      const { fakeKnex, calls } = createFakeKnex([
        undefined, // findOrCreateRow: ignore()
        { messages_used: 1 }, // findOrCreateRow: first() (unused by this branch)
        [{ messages_used: 5 }], // where(...).update(...).returning('*')
      ]);
      const service = new UsageService(fakeKnex);

      const result = await service.tryConsume('user-1', 'messages', 1, null);

      expect(result).toEqual({ used: 5, limit: null, remaining: null, canUse: true });
      // The unconditional-increment branch has no andWhere cap check.
      expect(calls[2].methodCalls.andWhere).toBeUndefined();
      expect((calls[2].methodCalls.update[0] as any).messages_used).toEqual({
        __raw: 'messages_used + ?',
        bindings: [1],
      });
    });

    it('increments and returns remaining when the conditional update stays under the cap', async () => {
      const { fakeKnex, calls } = createFakeKnex([
        undefined,
        { documents_used: 2 },
        [{ documents_used: 3 }], // conditional update matched — one row returned
      ]);
      const service = new UsageService(fakeKnex);

      const result = await service.tryConsume('user-1', 'documents', 1, 10);

      expect(result).toEqual({ used: 3, limit: 10, remaining: 7, canUse: true });
      expect(calls[2].methodCalls.andWhere[0]).toEqual({
        __raw: 'documents_used + ? <= ?',
        bindings: [1, 10],
      });
    });

    it('refuses and leaves the counter unchanged when the conditional update matches no row (at/over cap)', async () => {
      const { fakeKnex, calls } = createFakeKnex([
        undefined,
        { voice_seconds_used: 17940 },
        [], // conditional update matched nothing — already at the cap
        { voice_seconds_used: 18000 }, // fallback read of current state
      ]);
      const service = new UsageService(fakeKnex);

      const result = await service.tryConsume('user-1', 'voice_seconds', 60, 18000);

      expect(result).toEqual({ used: 18000, limit: 18000, remaining: 0, canUse: false });
      // Exactly one extra read to report current state — no retry/second write.
      expect(calls).toHaveLength(4);
    });

    it('short-circuits to a read-only status check when amount <= 0, never writing', async () => {
      const { fakeKnex, calls } = createFakeKnex([undefined, { documents_used: 4 }]);
      const service = new UsageService(fakeKnex);

      const result = await service.tryConsume('user-1', 'documents', 0, 10);

      expect(result).toEqual({ used: 4, limit: 10, remaining: 6, canUse: true });
      expect(calls.every((c) => !c.methodCalls.update)).toBe(true);
    });
  });
});
