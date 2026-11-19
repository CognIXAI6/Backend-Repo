import { PaymentService } from './payment.service';

describe('PaymentService.getMyPlan — documentQuota', () => {
  it('includes documentQuota computed from the same usage it already returns', async () => {
    const chain: any = { where: jest.fn().mockReturnThis(), whereIn: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
    const knex: any = jest.fn(() => chain);
    const entitlements = { maxMessagesPerMonth: null, maxVoiceMinutesPerMonth: null, maxDocumentsPerMonth: 25, allowedDocumentDepths: ['brief'], maxVideoAnalysesPerMonth: 0, maxWebSearchesPerMonth: null };
    const entitlementsService = { getUserEntitlements: jest.fn().mockResolvedValue({ tier: 'plus', entitlements }) };
    const st = (used: number, limit: number | null) => ({ used, limit, remaining: limit === null ? null : Math.max(0, limit - used), canUse: limit === null || used < limit });
    const usageService = {
      getAllStatuses: jest.fn().mockResolvedValue({ messages: st(1, null), voice_seconds: st(0, null), documents: st(25, 25), video_analyses: st(0, 0), web_searches: st(0, null) }),
    };
    const service = new PaymentService({ get: jest.fn() } as any, knex, {} as any, {} as any, {} as any, entitlementsService as any, usageService as any);

    const plan: any = await service.getMyPlan('user-1');
    expect(plan.usage.documents).toEqual(st(25, 25)); // existing field unchanged
    expect(plan.documentQuota).toMatchObject({ used: 25, limit: 25, canGenerate: false, reason: 'quota_exhausted' });
  });
});
