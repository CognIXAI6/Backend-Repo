import { buildDocumentQuota, usagePeriodResetsAt } from './document-quota';

describe('buildDocumentQuota', () => {
  const now = new Date('2026-11-19T15:00:00Z');
  const paid = { maxDocumentsPerMonth: 50, allowedDocumentDepths: ['brief', 'standard'] as any };

  it('ok while documents remain', () => {
    expect(buildDocumentQuota(paid, { used: 25, limit: 50, remaining: 25, canUse: true }, now)).toEqual({
      used: 25, limit: 50, remaining: 25, canGenerate: true, reason: 'ok', resetsAt: '2026-12-01T00:00:00.000Z', message: null,
    });
  });

  it('quota_exhausted once the allowance is used, with the reset date in the message', () => {
    const q = buildDocumentQuota(paid, { used: 50, limit: 50, remaining: 0, canUse: false }, now);
    expect(q).toMatchObject({ canGenerate: false, reason: 'quota_exhausted', remaining: 0, limit: 50, used: 50 });
    expect(q.message).toContain('2026-12-01');
  });

  it('plan_excluded for a plan with no documents (or no depths), regardless of usage', () => {
    expect(buildDocumentQuota({ maxDocumentsPerMonth: 0, allowedDocumentDepths: [] }, { used: 0, limit: 0, remaining: 0, canUse: false }, now))
      .toMatchObject({ canGenerate: false, reason: 'plan_excluded', limit: 0 });
    expect(buildDocumentQuota({ maxDocumentsPerMonth: 10, allowedDocumentDepths: [] }, { used: 0, limit: 10, remaining: 10, canUse: true }, now))
      .toMatchObject({ canGenerate: false, reason: 'plan_excluded' });
  });

  it('resets at the start of the next UTC month, including across the year end', () => {
    expect(usagePeriodResetsAt(new Date('2026-12-31T23:59:00Z'))).toBe('2027-01-01T00:00:00.000Z');
  });
});
