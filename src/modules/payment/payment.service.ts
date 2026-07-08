import { Injectable, Inject, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';

export type BillingCycle = 'monthly' | 'quarterly' | 'biannual' | 'yearly';

export interface SubscriptionPlan {
  id: string;
  billing_cycle: BillingCycle;
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

  // Backwards-compatible shape for the existing frontend contract.
  async getSubscriptionPrices(): Promise<Record<string, { label: string; amount: number; discount: number }>> {
    const plans = await this.getSubscriptionPlans();
    return Object.fromEntries(
      plans.map((p) => [
        p.billing_cycle,
        { label: p.label, amount: p.amount_cents / 100, discount: p.discount_percent },
      ]),
    );
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

  // ── Fix 4: price IDs come exclusively from env vars (single source of truth) ─

  private getStripePriceId(billingCycle: BillingCycle): string {
    const prices = this.configService.get<Record<string, string | undefined>>('stripe.prices') ?? {};
    const priceId = prices[billingCycle];

    if (!priceId) {
      throw new BadRequestException(
        `Stripe price ID not configured for "${billingCycle}". ` +
          `Set STRIPE_PRICE_${billingCycle.toUpperCase()} in your environment.`,
      );
    }

    return priceId;
  }

  // Reverse lookup: given a Stripe price ID, return the billing cycle.
  // Used in syncSubscription so webhook events don't need a DB round-trip.
  private getBillingCycleForPriceId(priceId: string): BillingCycle | null {
    const prices = this.configService.get<Record<string, string | undefined>>('stripe.prices') ?? {};
    const entry = Object.entries(prices).find(([, id]) => id === priceId);
    return (entry?.[0] as BillingCycle) ?? null;
  }

  // ── Fix 2: customer creation serialised with SELECT FOR UPDATE ───────────────

  private async getOrCreateStripeCustomer(
    userId: string,
    email: string,
    name?: string | null,
  ): Promise<string> {
    return this.knex.transaction(async (trx) => {
      // Lock the user row so concurrent requests for the same user serialise here
      // instead of both reading stripe_customer_id = null and creating two customers.
      const user = await trx('users').where('id', userId).forUpdate().first();

      if (user?.stripe_customer_id) return user.stripe_customer_id as string;

      // Fix 5: stable idempotency key — same user always maps to the same customer
      // even if this call is retried after a network timeout.
      const customer = await this.stripe.customers.create(
        { email, name: name ?? undefined },
        { idempotencyKey: `customer-create-${userId}` },
      );

      await trx('users')
        .where('id', userId)
        .update({ stripe_customer_id: customer.id, updated_at: new Date() });

      return customer.id;
    });
  }

  // ── Checkout session ──────────────────────────────────────────────────────────

  async createCheckoutSession(
    userId: string,
    email: string,
    name: string | null | undefined,
    billingCycle: BillingCycle,
    successUrl?: string | null,
    cancelUrl?: string | null,
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

    // Validates plan exists and price ID is configured — throws descriptive 400 if not
    await this.getPlanByBillingCycle(billingCycle);
    const stripePriceId = this.getStripePriceId(billingCycle);

    const customerId = await this.getOrCreateStripeCustomer(userId, email, name);
    const frontendUrl = this.configService.get<string>('app.frontendUrl') ?? '';

    // Clients pass their own URLs so each platform gets the right redirect:
    //   Web:     https://cognixai.ca/payment/success
    //   Mobile:  cognix://payment/success   (deep link — OS opens the app)
    // Falls back to the configured frontend URL if not provided.
    // {CHECKOUT_SESSION_ID} is appended automatically so every platform receives
    // the session ID and can poll GET /payment/my-subscription to confirm activation.
    const baseSuccessUrl = successUrl ?? `${frontendUrl}/payment/success`;
    const separator = baseSuccessUrl.includes('?') ? '&' : '?';
    const resolvedSuccessUrl = `${baseSuccessUrl}${separator}session_id={CHECKOUT_SESSION_ID}`;
    const resolvedCancelUrl = cancelUrl ?? `${frontendUrl}/payment/cancel`;

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: resolvedSuccessUrl,
      cancel_url: resolvedCancelUrl,
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

  // Fix 1: ownership check — user can only cancel their own subscription
  // Fix 3: immediately downgrade user tier; webhook acts as self-healing fallback
  async getPaymentHistory(userId: string): Promise<{
    invoices: Array<{
      id: string;
      amount: number;
      currency: string;
      status: string;
      billingCycle: string | null;
      periodStart: Date;
      periodEnd: Date;
      invoiceUrl: string | null;
      pdfUrl: string | null;
      paidAt: Date | null;
      createdAt: Date;
    }>;
    subscription: unknown;
  }> {
    const user = await this.knex('users').where('id', userId).first();

    if (!user?.stripe_customer_id) {
      return { invoices: [], subscription: null };
    }

    const [stripeInvoices, subscription] = await Promise.all([
      this.stripe.invoices.list({
        customer: user.stripe_customer_id,
        limit: 24,
        expand: ['data.subscription'],
      }),
      this.getUserSubscription(userId),
    ]);

    const prices = this.configService.get<Record<string, string | undefined>>('stripe.prices') ?? {};

    const invoices = stripeInvoices.data.map((inv) => {
      const priceId = inv.lines.data[0]?.price?.id ?? null;
      const billingCycle = priceId ? (Object.entries(prices).find(([, id]) => id === priceId)?.[0] ?? null) : null;

      return {
        id: inv.id,
        amount: inv.amount_paid / 100,
        currency: inv.currency.toUpperCase(),
        status: inv.status ?? 'unknown',
        billingCycle,
        periodStart: new Date((inv.period_start) * 1000),
        periodEnd: new Date((inv.period_end) * 1000),
        invoiceUrl: inv.hosted_invoice_url ?? null,
        pdfUrl: inv.invoice_pdf ?? null,
        paidAt: inv.status_transitions.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : null,
        createdAt: new Date(inv.created * 1000),
      };
    });

    return { invoices, subscription };
  }

  async cancelSubscription(
    userId: string,
    subscriptionId: string,
  ): Promise<{ canceled: boolean }> {
    const sub = await this.knex('subscriptions')
      .where({ stripe_subscription_id: subscriptionId, user_id: userId })
      .first();

    if (!sub) {
      throw new NotFoundException('Subscription not found');
    }

    await this.stripe.subscriptions.cancel(subscriptionId);

    await this.knex('subscriptions')
      .where('stripe_subscription_id', subscriptionId)
      .update({ status: 'canceled', canceled_at: new Date(), updated_at: new Date() });

    // Downgrade immediately — don't wait for the webhook
    await this.knex('users')
      .where('id', userId)
      .update({ subscription_tier: 'free', updated_at: new Date() });

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
      case 'invoice.paid':
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

  // Primary activation path — fires once after the user completes payment on
  // Stripe's hosted page.
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

  // Self-healing fallback — keeps the row in sync for renewals, plan changes,
  // and any lifecycle event from the Stripe dashboard.
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

    // Fix 4: resolve billing_cycle from config (single source of truth for price IDs)
    const priceId = subscription.items.data[0]?.price.id ?? null;
    const billingCycle = priceId ? this.getBillingCycleForPriceId(priceId) : null;

    const isActive = subscription.status === 'active' || subscription.status === 'trialing';

    await this.knex('subscriptions')
      .insert({
        user_id: user.id,
        stripe_subscription_id: subscription.id,
        stripe_price_id: priceId,
        billing_cycle: billingCycle,
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
