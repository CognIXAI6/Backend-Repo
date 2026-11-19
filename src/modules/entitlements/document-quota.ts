import { PlanEntitlements } from './entitlements.types';
import { UsageStatus } from './usage.service';

/**
 * Where a user stands on documents (meeting summaries + generated documents) this month.
 * One shape for every place the client reads it — GET /auth/profile, GET /payment/my-plan
 * and the `feature:unavailable` socket event — so they can never disagree.
 *
 *   reason 'ok'              — documents can still be generated
 *   reason 'quota_exhausted' — this month's allowance is used up (resets at `resetsAt`)
 *   reason 'plan_excluded'   — the plan includes no documents at all (upgrade needed)
 */
export interface DocumentQuota {
  used: number;
  /** null = unlimited */
  limit: number | null;
  remaining: number | null;
  canGenerate: boolean;
  reason: 'ok' | 'quota_exhausted' | 'plan_excluded';
  /** ISO time the monthly allowance resets (start of next calendar month, UTC). */
  resetsAt: string;
  /** User-facing explanation; null when reason is 'ok'. */
  message: string | null;
}

/** Start of the next calendar month in UTC — when usage_counters rolls over to a new period. */
export function usagePeriodResetsAt(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export function buildDocumentQuota(
  entitlements: Pick<PlanEntitlements, 'maxDocumentsPerMonth' | 'allowedDocumentDepths'>,
  status: Pick<UsageStatus, 'used' | 'limit' | 'remaining' | 'canUse'>,
  now: Date = new Date(),
): DocumentQuota {
  const resetsAt = usagePeriodResetsAt(now);
  const planExcluded = entitlements.maxDocumentsPerMonth <= 0 || entitlements.allowedDocumentDepths.length === 0;
  if (planExcluded) {
    return {
      used: status.used,
      limit: 0,
      remaining: 0,
      canGenerate: false,
      reason: 'plan_excluded',
      resetsAt,
      message: 'Your plan does not include meeting summaries or documents. Upgrade to get them.',
    };
  }
  if (!status.canUse) {
    return {
      used: status.used,
      limit: status.limit,
      remaining: 0,
      canGenerate: false,
      reason: 'quota_exhausted',
      resetsAt,
      message: `You've used all ${status.limit} documents included in your plan this month, so meeting summaries won't be generated until ${resetsAt.slice(0, 10)}. Upgrade for more.`,
    };
  }
  return { used: status.used, limit: status.limit, remaining: status.remaining, canGenerate: true, reason: 'ok', resetsAt, message: null };
}
