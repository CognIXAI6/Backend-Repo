import { Injectable, Inject, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { PlanEntitlements, PlanType, FREE_FALLBACK_ENTITLEMENTS } from './entitlements.types';

interface PlanEntitlementsRow {
  plan_type: PlanType;
  max_messages_per_month: number | null;
  max_voice_minutes_per_month: number | null;
  allowed_voice_modes: string[];
  max_documents_per_month: number;
  allowed_document_depths: string[];
  max_video_analyses_per_month: number;
  max_video_minutes_per_analysis: number;
  max_web_searches_per_month: number | null;
  support_tier: string;
  priority_memory: boolean;
}

function toEntitlements(row: PlanEntitlementsRow): PlanEntitlements {
  return {
    planType: row.plan_type,
    maxMessagesPerMonth: row.max_messages_per_month,
    maxVoiceMinutesPerMonth: row.max_voice_minutes_per_month,
    allowedVoiceModes: (row.allowed_voice_modes ?? []) as PlanEntitlements['allowedVoiceModes'],
    maxDocumentsPerMonth: row.max_documents_per_month,
    allowedDocumentDepths: (row.allowed_document_depths ?? []) as PlanEntitlements['allowedDocumentDepths'],
    maxVideoAnalysesPerMonth: row.max_video_analyses_per_month,
    maxVideoMinutesPerAnalysis: row.max_video_minutes_per_analysis,
    maxWebSearchesPerMonth: row.max_web_searches_per_month,
    supportTier: row.support_tier,
    priorityMemory: row.priority_memory,
  };
}

/**
 * Single source of truth for "what does this tier unlock" — reads
 * plan_entitlements (admin-editable) and resolves which tier a user is
 * actually entitled to right now. Every gating site in the app (voice
 * gateway, document service, chat message service) goes through this.
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  // Short TTL cache — gating runs on every socket turn, so we don't want a
  // DB round-trip per message, but an admin edit should still take effect
  // within a few seconds without a restart. AdminPlansService calls
  // invalidate() on write for the common case of an immediate edit.
  private readonly CACHE_TTL_MS = 30_000;
  private cache = new Map<PlanType, { value: PlanEntitlements; expiresAt: number }>();

  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  invalidate(planType?: PlanType): void {
    if (planType) this.cache.delete(planType);
    else this.cache.clear();
  }

  async getEntitlementsForTier(planType: PlanType): Promise<PlanEntitlements> {
    const cached = this.cache.get(planType);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await this.knex('plan_entitlements').where('plan_type', planType).first();

    if (!row) {
      this.logger.warn(`No plan_entitlements row for "${planType}" — falling back to Free-level limits`);
      const fallback = { ...FREE_FALLBACK_ENTITLEMENTS, planType };
      this.cache.set(planType, { value: fallback, expiresAt: Date.now() + this.CACHE_TTL_MS });
      return fallback;
    }

    const entitlements = toEntitlements(row);
    this.cache.set(planType, { value: entitlements, expiresAt: Date.now() + this.CACHE_TTL_MS });
    return entitlements;
  }

  /**
   * Resolves the tier a user is actually entitled to right now — not just
   * whatever users.subscription_tier currently says. A paid tier is only
   * honoured when a matching active/trialing subscription row also exists;
   * this is defense in depth alongside payment.service.ts's own downgrade
   * calls, for the gap between a lapsed subscription and the next webhook.
   */
  async resolveUserTier(userId: string): Promise<PlanType> {
    const user = await this.knex('users').where('id', userId).first('subscription_tier');
    const tier = (user?.subscription_tier ?? 'free') as PlanType;

    if (tier === 'free') return 'free';

    const activeSub = await this.knex('subscriptions')
      .where('user_id', userId)
      .whereIn('status', ['active', 'trialing'])
      .first();

    if (!activeSub) {
      this.logger.warn(`User ${userId} has tier="${tier}" but no active subscription row — treating as free`);
      return 'free';
    }

    return tier;
  }

  async getUserEntitlements(userId: string): Promise<{ tier: PlanType; entitlements: PlanEntitlements }> {
    const tier = await this.resolveUserTier(userId);
    const entitlements = await this.getEntitlementsForTier(tier);
    return { tier, entitlements };
  }
}
