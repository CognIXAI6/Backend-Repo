import { AuthController } from './auth.controller';

describe('AuthController.profile — documentQuota', () => {
  const user = { id: 'user-1', email: 'owner@example.com', name: 'Temi' };
  const make = (entitlements: any, status: any) => {
    const entitlementsService = { getUserEntitlements: jest.fn().mockResolvedValue({ tier: 'xpress', entitlements }) };
    const usageService = { getStatus: jest.fn().mockResolvedValue(status) };
    return { controller: new AuthController({} as any, entitlementsService as any, usageService as any), usageService };
  };

  it('keeps the existing profile fields and adds where the user stands on documents', async () => {
    const { controller, usageService } = make(
      { maxDocumentsPerMonth: 50, allowedDocumentDepths: ['brief'] },
      { used: 50, limit: 50, remaining: 0, canUse: false },
    );
    const res: any = await controller.profile(user);
    expect(res).toMatchObject(user);
    expect(res.documentQuota).toMatchObject({ used: 50, limit: 50, remaining: 0, canGenerate: false, reason: 'quota_exhausted' });
    expect(usageService.getStatus).toHaveBeenCalledWith('user-1', 'documents', 50);
  });

  it('reports ok while documents remain', async () => {
    const { controller } = make({ maxDocumentsPerMonth: 10, allowedDocumentDepths: ['brief'] }, { used: 2, limit: 10, remaining: 8, canUse: true });
    expect((await controller.profile(user) as any).documentQuota).toMatchObject({ canGenerate: true, reason: 'ok', remaining: 8, message: null });
  });
});
