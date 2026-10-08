import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PlanType, VoiceMode, DocumentDepth } from '../entitlements/entitlements.types';
import { PaymentService, BillingCycle } from '../payment/payment.service';
import { StripeSyncService } from '../payment/stripe-sync.service';

export interface UpdatePlanDto {
  amountCents?: number;
  discountPercent?: number;
  label?: string;
  isActive?: boolean;
}

export interface CreatePlanDto {
  planType: PlanType;
  billingCycle: BillingCycle;
  amountCents: number;
  currency?: string;
  label: string;
  discountPercent?: number;
}

export interface UpdateEntitlementsDto {
  maxMessagesPerMonth?: number | null;
  maxVoiceMinutesPerMonth?: number | null;
  allowedVoiceModes?: VoiceMode[];
  maxDocumentsPerMonth?: number;
  allowedDocumentDepths?: DocumentDepth[];
  maxVideoAnalysesPerMonth?: number;
  maxVideoMinutesPerAnalysis?: number;
  maxWebSearchesPerMonth?: number | null;
  supportTier?: string;
  priorityMemory?: boolean;
}

/**
 * Admin surface for everything in the pricing ledger that was previously
 * static: per-tier pricing (subscription_plans), what each tier unlocks
 * (plan_entitlements), and publishing a price change to Stripe
 * (StripeSyncService). All reads/writes here are what EntitlementsService
 * and PaymentService consult at request time — nothing here is cached
 * beyond EntitlementsService's own short TTL, which this invalidates on write.
 */
@Injectable()
export class AdminPlansService {
  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly entitlementsService: EntitlementsService,
    private readonly paymentService: PaymentService,
    private readonly stripeSyncService: StripeSyncService,
  ) {}

  // ── Plans (pricing) ─────────────────────────────────────────────────────

  async listPlans() {
    const [plans, entitlements] = await Promise.all([
      this.knex('subscription_plans')
        .select('*')
        .orderByRaw(
          `ARRAY_POSITION(ARRAY['free','standard','plus','xpress']::text[], plan_type::text),
           ARRAY_POSITION(ARRAY['monthly','quarterly','biannual','yearly']::text[], billing_cycle::text)`,
        ),
      this.knex('plan_entitlements').select('*'),
    ]);

    const entitlementsByType = new Map(entitlements.map((e: any) => [e.plan_type, e]));

    return plans.map((p: any) => ({ ...p, entitlements: entitlementsByType.get(p.plan_type) ?? null }));
  }

  async createPlan(dto: CreatePlanDto) {
    const [plan] = await this.knex('subscription_plans')
      .insert({
        plan_type: dto.planType,
        billing_cycle: dto.billingCycle,
        amount_cents: dto.amountCents,
        currency: (dto.currency ?? 'usd').toLowerCase(),
        label: dto.label,
        discount_percent: dto.discountPercent ?? 0,
        is_active: true,
      })
      .returning('*');
    return plan;
  }

  async updatePlan(id: string, dto: UpdatePlanDto) {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (dto.amountCents !== undefined) patch.amount_cents = dto.amountCents;
    if (dto.discountPercent !== undefined) patch.discount_percent = dto.discountPercent;
    if (dto.label !== undefined) patch.label = dto.label;
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;

    const [plan] = await this.knex('subscription_plans').where('id', id).update(patch).returning('*');
    if (!plan) throw new NotFoundException('Plan not found');

    // Pricing changes here don't touch Stripe — that's a deliberate separate
    // step (see publish()) so an admin can stage several edits and publish
    // them together, and so a typo doesn't immediately mint a live Price.
    return plan;
  }

  async publish(planId: string) {
    return this.stripeSyncService.publishPlanPrice(planId);
  }

  async setPriceOverride(planId: string, currency: string, amountMajorUnits: number) {
    const plan = await this.getPlanOrThrow(planId);
    return this.paymentService.setPriceOverride(plan.billing_cycle, currency, amountMajorUnits, plan.plan_type);
  }

  async clearPriceOverride(planId: string, currency: string) {
    const plan = await this.getPlanOrThrow(planId);
    return this.paymentService.clearPriceOverride(plan.billing_cycle, currency, plan.plan_type);
  }

  private async getPlanOrThrow(planId: string) {
    const plan = await this.knex('subscription_plans').where('id', planId).first();
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  // ── Entitlements (what a tier unlocks) ──────────────────────────────────

  async getEntitlements(planType: PlanType) {
    const row = await this.knex('plan_entitlements').where('plan_type', planType).first();
    if (!row) throw new NotFoundException(`No entitlements row for plan_type "${planType}"`);
    return row;
  }

  async updateEntitlements(planType: PlanType, dto: UpdateEntitlementsDto, adminId: string) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('No fields provided to update');
    }

    const patch: Record<string, unknown> = { updated_by_admin_id: adminId, updated_at: new Date() };
    if (dto.maxMessagesPerMonth !== undefined) patch.max_messages_per_month = dto.maxMessagesPerMonth;
    if (dto.maxVoiceMinutesPerMonth !== undefined) patch.max_voice_minutes_per_month = dto.maxVoiceMinutesPerMonth;
    if (dto.allowedVoiceModes !== undefined) patch.allowed_voice_modes = JSON.stringify(dto.allowedVoiceModes);
    if (dto.maxDocumentsPerMonth !== undefined) patch.max_documents_per_month = dto.maxDocumentsPerMonth;
    if (dto.allowedDocumentDepths !== undefined) patch.allowed_document_depths = JSON.stringify(dto.allowedDocumentDepths);
    if (dto.maxVideoAnalysesPerMonth !== undefined) patch.max_video_analyses_per_month = dto.maxVideoAnalysesPerMonth;
    if (dto.maxVideoMinutesPerAnalysis !== undefined) patch.max_video_minutes_per_analysis = dto.maxVideoMinutesPerAnalysis;
    if (dto.maxWebSearchesPerMonth !== undefined) patch.max_web_searches_per_month = dto.maxWebSearchesPerMonth;
    if (dto.supportTier !== undefined) patch.support_tier = dto.supportTier;
    if (dto.priorityMemory !== undefined) patch.priority_memory = dto.priorityMemory;

    const [row] = await this.knex('plan_entitlements').where('plan_type', planType).update(patch).returning('*');
    if (!row) throw new NotFoundException(`No entitlements row for plan_type "${planType}"`);

    // Next gating check reads fresh instead of waiting out the TTL.
    this.entitlementsService.invalidate(planType);

    return row;
  }
}
