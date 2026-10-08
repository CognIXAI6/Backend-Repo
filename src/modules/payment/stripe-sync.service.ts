import { Injectable, Inject, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { BillingCycle, SubscriptionPlan } from './payment.service';

/**
 * Publishes an admin-edited subscription_plans row to Stripe: creates (or
 * reuses) one Product per plan_type, mints a fresh Price for the plan's
 * current amount/currency/billing-cycle, archives whatever Price it
 * replaces, and writes the new IDs back onto the row. This is the only
 * place anything in the app writes subscription_plans.stripe_price_id —
 * PaymentService only ever reads it.
 *
 * Stripe Prices are immutable (amount can't be edited in place), so
 * "republishing" a changed price is always create-new + archive-old, never
 * an update of the existing Price object.
 */
@Injectable()
export class StripeSyncService {
  private readonly logger = new Logger(StripeSyncService.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
  ) {
    const secretKey = this.configService.get<string>('stripe.secretKey');
    this.stripe = new Stripe(secretKey ?? '', { apiVersion: '2023-10-16' });
  }

  private intervalForBillingCycle(cycle: BillingCycle): { interval: Stripe.PriceCreateParams.Recurring.Interval; interval_count: number } {
    switch (cycle) {
      case 'monthly': return { interval: 'month', interval_count: 1 };
      case 'quarterly': return { interval: 'month', interval_count: 3 };
      case 'biannual': return { interval: 'month', interval_count: 6 };
      case 'yearly': return { interval: 'year', interval_count: 1 };
      default: throw new BadRequestException(`Unknown billing cycle: ${cycle}`);
    }
  }

  async publishPlanPrice(planId: string): Promise<SubscriptionPlan> {
    const plan = await this.knex('subscription_plans').where('id', planId).first();
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.plan_type === 'free') {
      throw new BadRequestException('The free plan has no price to publish to Stripe');
    }

    // Reuse an existing Product for this plan_type if any sibling billing-cycle
    // row already created one — one Product per tier, many Prices under it.
    let productId: string | null = plan.stripe_product_id;
    if (!productId) {
      const sibling = await this.knex('subscription_plans')
        .where({ plan_type: plan.plan_type })
        .whereNotNull('stripe_product_id')
        .whereNot('id', plan.id)
        .first();
      productId = sibling?.stripe_product_id ?? null;
    }

    if (!productId) {
      const product = await this.stripe.products.create({
        name: `CognIX ${plan.plan_type.charAt(0).toUpperCase()}${plan.plan_type.slice(1)}`,
        metadata: { planType: plan.plan_type },
      });
      productId = product.id;
      this.logger.log(`Created Stripe product ${productId} for plan_type=${plan.plan_type}`);
    }

    const { interval, interval_count } = this.intervalForBillingCycle(plan.billing_cycle);

    const newPrice = await this.stripe.prices.create({
      product: productId,
      currency: plan.currency,
      unit_amount: plan.amount_cents,
      recurring: { interval, interval_count },
      metadata: { planType: plan.plan_type, billingCycle: plan.billing_cycle },
    });

    const oldPriceId: string | null = plan.stripe_price_id;
    if (oldPriceId && oldPriceId !== newPrice.id) {
      // Best-effort — stops new checkouts on the old price without touching
      // subscribers already on it; a failure here must not block the publish.
      await this.stripe.prices.update(oldPriceId, { active: false }).catch((err) => {
        this.logger.warn(`Failed to archive old Stripe price ${oldPriceId}: ${(err as Error).message}`);
      });
    }

    const [updated] = await this.knex('subscription_plans')
      .where('id', planId)
      .update({ stripe_product_id: productId, stripe_price_id: newPrice.id, updated_at: new Date() })
      .returning('*');

    this.logger.log(
      `Published ${plan.plan_type}/${plan.billing_cycle}: product=${productId} price=${newPrice.id}` +
        (oldPriceId ? ` (archived ${oldPriceId})` : ''),
    );

    return updated;
  }
}
