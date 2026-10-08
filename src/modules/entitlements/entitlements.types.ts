export type PlanType = 'free' | 'standard' | 'plus' | 'xpress';

export type VoiceMode = 'single' | 'dual_speaker' | 'multiple_speaker';

export type DocumentDepth = 'brief' | 'standard' | 'comprehensive';

export type UsageKind = 'messages' | 'voice_seconds' | 'documents' | 'video_analyses' | 'web_searches';

export interface PlanEntitlements {
  planType: PlanType;
  /** null = unlimited / fair-use */
  maxMessagesPerMonth: number | null;
  /** null = unlimited / fair-use */
  maxVoiceMinutesPerMonth: number | null;
  allowedVoiceModes: VoiceMode[];
  maxDocumentsPerMonth: number;
  allowedDocumentDepths: DocumentDepth[];
  maxVideoAnalysesPerMonth: number;
  maxVideoMinutesPerAnalysis: number;
  /** null = unlimited / fair-use */
  maxWebSearchesPerMonth: number | null;
  supportTier: string;
  priorityMemory: boolean;
}

// Fail-closed default used when a plan_entitlements row is unexpectedly
// missing (e.g. a new plan_type shipped without a matching entitlements
// row) — the app must never silently fail open to unlimited access.
export const FREE_FALLBACK_ENTITLEMENTS: PlanEntitlements = {
  planType: 'free',
  maxMessagesPerMonth: 450,
  maxVoiceMinutesPerMonth: 30,
  allowedVoiceModes: ['single'],
  maxDocumentsPerMonth: 0,
  allowedDocumentDepths: [],
  maxVideoAnalysesPerMonth: 0,
  maxVideoMinutesPerAnalysis: 0,
  maxWebSearchesPerMonth: 10,
  supportTier: 'none',
  priorityMemory: false,
};

/** tier !== 'free' — use instead of a hardcoded `=== 'premium'` check so
 *  gating doesn't silently stop working for 'plus'/'xpress' users. */
export function isPaidTier(tier: string | null | undefined): boolean {
  return !!tier && tier !== 'free';
}
