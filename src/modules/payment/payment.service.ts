import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';

export type BillingCycle = 'monthly' | 'quarterly' | 'biannual' | 'yearly';

export interface SubscriptionPlan {
  id: string;
  billing_cycle: BillingCycle;
  stripe_price_id: string | null;
  amount_cents: number;
  currency: string;
  label: string;
  discount_percent: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly stripe: Stripe;

  constructor(
    private configService: ConfigService,
    @Inject(KNEX_CONNECTION) private knex: Knex,
  ) {
    const secretKey = this.configService.get<string>('stripe.secretKey');
    if (!secretKey) {
      this.logger.warn('Stripe secret key not configured — payment features disabled');
    }
    this.stripe = new Stripe(secretKey ?? '', {
      apiVersion: '2023-10-16',
    });
  }

  // ── Plans (from DB) ──────────────────────────────────────────────────────────

  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return this.knex('subscription_plans')
      .where('is_active', true)
      .orderByRaw(
        `ARRAY_POSITION(ARRAY['monthly','quarterly','biannual','yearly']::text[], billing_cycle::text)`,
      )
      .select('*');
  }

  private async getPlanByBillingCycle(billingCycle: BillingCycle): Promise<SubscriptionPlan> {
    const plan = await this.knex('subscription_plans')
      .where({ billing_cycle: billingCycle, is_active: true })
      .first();

    if (!plan) {
      throw new BadRequestException(`No active plan found for billing cycle: ${billingCycle}`);
    }

    return plan;
  }

  // ── Customer ─────────────────────────────────────────────────────────────────

  private async getOrCreateStripeCustomer(
    userId: string,
    email: string,
    name?: string | null,
  ): Promise<string> {
    const user = await this.knex('users').where('id', userId).first();

    if (user?.stripe_customer_id) {
      return user.stripe_customer_id as string;
    }

    const customer = await this.stripe.customers.create({
      email,
      name: name ?? undefined,
    });

    await this.knex('users')
      .where('id', userId)
      .update({ stripe_customer_id: customer.id, updated_at: new Date() });

    return customer.id;
  }

  // ── Checkout session ──────────────────────────────────────────────────────────
  // The frontend opens checkoutUrl — Stripe hosts the payment page entirely.
  // No Stripe.js integration needed on the frontend.

  async createCheckoutSession(
    userId: string,
    email: string,
    name: string | null | undefined,
    billingCycle: BillingCycle,
  ): Promise<{ checkoutUrl: string }> {
    const existing = await this.knex('subscriptions')
      .where({ user_id: userId })
      .whereIn('status', ['active', 'trialing'])
      .first();

    if (existing) {
      throw new BadRequestException(
        'You already have an active subscription. Cancel it before subscribing to a new plan.',
      );
    }

    const plan = await this.getPlanByBillingCycle(billingCycle);

    if (!plan.stripe_price_id) {
      throw new BadRequestException(
        `Stripe price ID not configured for the "${plan.label}" plan. ` +
          'Please contact support or configure the plan in the dashboard.',
      );
    }

    const customerId = await this.getOrCreateStripeCustomer(userId, email, name);
    const frontendUrl = this.configService.get<string>('app.frontendUrl') ?? '';

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: `${frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/payment/cancel`,
      // Stored on the session so the checkout.session.completed webhook can
      // create the subscriptions row without a second Stripe lookup.
      metadata: { userId, billingCycle },
    });

    if (!session.url) {
      throw new Error('Stripe did not return a checkout URL');
    }

    return { checkoutUrl: session.url };
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────────

  async getUserSubscription(userId: string) {
    return this.knex('subscriptions')
      .where({ user_id: userId })
      .whereIn('status', ['active', 'trialing', 'past_due'])
      .orderBy('created_at', 'desc')
      .first();
  }

  async cancelSubscription(subscriptionId: string): Promise<{ canceled: boolean }> {
    await this.stripe.subscriptions.cancel(subscriptionId);

    await this.knex('subscriptions')
      .where('stripe_subscription_id', subscriptionId)
      .update({
        status: 'canceled',
        canceled_at: new Date(),
        updated_at: new Date(),
      });

    return { canceled: true };
  }

  // ── Webhook ───────────────────────────────────────────────────────────────────

  async handleWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<{ received: boolean }> {
    const webhookSecret = this.configService.get<string>('stripe.webhookSecret');

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret ?? '');
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Webhook signature verification failed');
    }

    this.logger.log(`Stripe event: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.syncSubscription(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_succeeded':
        await this.handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      default:
        this.logger.log(`Unhandled Stripe event: ${event.type}`);
    }

    return { received: true };
  }

  // Primary activation path — fires once, after the user completes payment on
  // Stripe's hosted page. Creates (or updates) the subscriptions row using the
  // userId and billingCycle stored in session.metadata.
  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const { userId, billingCycle } = session.metadata ?? {};

    if (!userId || !session.subscription) {
      this.logger.warn(
        `checkout.session.completed missing metadata or subscription — session ${session.id}`,
      );
      return;
    }

    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;

    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);

    await this.knex('subscriptions')
      .insert({
        user_id: userId,
        stripe_subscription_id: subscription.id,
        stripe_price_id: subscription.items.data[0]?.price.id ?? null,
        billing_cycle: billingCycle ?? null,
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
      })
      .onConflict('stripe_subscription_id')
      .merge({
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
        updated_at: new Date(),
      });

    await this.knex('users')
      .where('id', userId)
      .update({ subscription_tier: 'premium', updated_at: new Date() });

    this.logger.log(`Subscription activated for user ${userId} via checkout session ${session.id}`);
  }

  // Self-healing fallback — keeps the subscriptions row in sync whenever Stripe
  // sends a subscription lifecycle event (created, updated, renewed, etc.).
  private async syncSubscription(subscription: Stripe.Subscription): Promise<void> {
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;

    const user = await this.knex('users').where('stripe_customer_id', customerId).first();
    if (!user) {
      this.logger.warn(`syncSubscription: no user found for Stripe customer ${customerId}`);
      return;
    }

    const priceId = subscription.items.data[0]?.price.id ?? null;
    const plan = priceId
      ? await this.knex('subscription_plans').where('stripe_price_id', priceId).first()
      : null;

    const isActive = subscription.status === 'active' || subscription.status === 'trialing';

    await this.knex('subscriptions')
      .insert({
        user_id: user.id,
        stripe_subscription_id: subscription.id,
        stripe_price_id: priceId,
        billing_cycle: plan?.billing_cycle ?? null,
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
      })
      .onConflict('stripe_subscription_id')
      .merge({
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
        updated_at: new Date(),
      });

    await this.knex('users')
      .where('id', user.id)
      .update({ subscription_tier: isActive ? 'premium' : 'free', updated_at: new Date() });
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    await this.knex('subscriptions')
      .where('stripe_subscription_id', subscription.id)
      .update({ status: 'canceled', canceled_at: new Date(), updated_at: new Date() });

    const sub = await this.knex('subscriptions')
      .where('stripe_subscription_id', subscription.id)
      .first();

    if (sub) {
      await this.knex('users')
        .where('id', sub.user_id)
        .update({ subscription_tier: 'free', updated_at: new Date() });
    }
  }

  private async handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    this.logger.log(`Payment succeeded for invoice ${invoice.id}`);
    if (!invoice.subscription) return;

    const subscriptionId =
      typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;

    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    await this.syncSubscription(subscription);
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    this.logger.warn(`Payment failed for invoice ${invoice.id}`);
    if (!invoice.subscription) return;

    const subscriptionId =
      typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;

    await this.knex('subscriptions')
      .where('stripe_subscription_id', subscriptionId)
      .update({ status: 'past_due', updated_at: new Date() });

    const sub = await this.knex('subscriptions')
      .where('stripe_subscription_id', subscriptionId)
      .first();

    if (sub) {
      await this.knex('users')
        .where('id', sub.user_id)
        .update({ subscription_tier: 'free', updated_at: new Date() });
    }
  }
}
