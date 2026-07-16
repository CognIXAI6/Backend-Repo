import { Injectable, Inject, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { GeoService, getCountryConfig } from './geo.service';
import { FxService } from './fx.service';
import { FlutterwaveService, FlutterwaveWebhookPayload } from './flutterwave.service';

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

export interface LocalizedPlan {
  billingCycle: BillingCycle;
  label: string;
  currency: string;
  amount: number;           // major unit (e.g. 12400 NGN, not kobo)
  amountDisplay: string;    // formatted: "₦12,400" / "$8"
  discountPercent: number;
  provider: 'stripe' | 'flutterwave';
  isOverride: boolean;      // true = admin-pinned price, false = live FX rate
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly stripe: Stripe;

  constructor(
    private configService: ConfigService,
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private geoService: GeoService,
    private fxService: FxService,
    private flutterwaveService: FlutterwaveService,
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

  // Geo-aware plans: returns prices in the user's local currency using live FX
  // rates, or an admin-pinned override stored in subscription_plan_prices.
  async getLocalizedPlans(clientIp: string, countryOverride?: string): Promise<LocalizedPlan[]> {
    const country = countryOverride ?? (await this.geoService.detectCountry(clientIp)) ?? 'US';
    const { currency, provider } = getCountryConfig(country);

    this.logger.log(`getLocalizedPlans: ip=${clientIp} → country=${country} → currency=${currency} provider=${provider}`);

    const plans = await this.getSubscriptionPlans();

    // Load any admin overrides for this currency in one query
    const overrides = await this.knex('subscription_plan_prices')
      .whereIn('plan_id', plans.map((p) => p.id))
      .where({ currency, is_active: true })
      .select('plan_id', 'amount_override_cents');

    const overrideMap = new Map(overrides.map((o: any) => [o.plan_id, o.amount_override_cents as number]));

    const rate = currency !== 'USD' ? await this.fxService.getRate('USD', currency) : 1;

    return plans.map((plan) => {
      const overrideCents = overrideMap.get(plan.id) ?? null;

      const amountCents =
        overrideCents !== null
          ? overrideCents
          : this.fxService.convertFromUsdCents(plan.amount_cents, currency, rate);

      const amount = amountCents / 100;
      const amountDisplay = this.fxService.formatAmount(amountCents, currency);

      return {
        billingCycle: plan.billing_cycle,
        label: plan.label,
        currency,
        amount,
        amountDisplay,
        discountPercent: plan.discount_percent,
        provider,
        isOverride: overrideCents !== null,
      };
    });
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

  // ── Admin: FX rates + price overrides ────────────────────────────────────────

  async getFxRatesPreview() {
    return this.fxService.getAllRates();
  }

  async setPriceOverride(
    billingCycle: BillingCycle,
    currency: string,
    amountMajorUnits: number,
  ): Promise<{ updated: boolean }> {
    const plan = await this.getPlanByBillingCycle(billingCycle);
    const amountCents = Math.round(amountMajorUnits * 100);

    await this.knex('subscription_plan_prices')
      .insert({
        plan_id: plan.id,
        currency: currency.toUpperCase(),
        amount_override_cents: amountCents,
        is_active: true,
      })
      .onConflict(['plan_id', 'currency'])
      .merge({ amount_override_cents: amountCents, updated_at: new Date() });

    this.logger.log(`Price override set: ${billingCycle} / ${currency} = ${amountMajorUnits}`);
    return { updated: true };
  }

  async clearPriceOverride(billingCycle: BillingCycle, currency: string): Promise<{ cleared: boolean }> {
    const plan = await this.getPlanByBillingCycle(billingCycle);
    await this.knex('subscription_plan_prices')
      .where({ plan_id: plan.id, currency: currency.toUpperCase() })
      .delete();
    return { cleared: true };
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
      const user = await trx('users').where('id', userId).forUpdate().first();
      const existingId = user?.stripe_customer_id as string | null;

      if (existingId) {
        // Verify the stored ID still exists in the current Stripe mode.
        // Fails when IDs were created in test mode but live key is now active (or vice versa),
        // or when a customer was manually deleted in the Stripe dashboard.
        let valid = false;
        try {
          const existing = await this.stripe.customers.retrieve(existingId);
          valid = !(existing as Stripe.DeletedCustomer).deleted;
        } catch (err) {
          if ((err as any).code !== 'resource_missing') throw err;
          // resource_missing = stale ID (test/live mismatch or deleted) — fall through
        }

        if (valid) return existingId;

        this.logger.warn(
          `Stale Stripe customer ${existingId} for user ${userId} (test/live mismatch or deleted) — creating a new one`,
        );
      }

      // Use a different idempotency key for recreation vs first creation so Stripe
      // doesn't return the cached (now-invalid) customer from the original key.
      const idempotencyKey = existingId
        ? `customer-recreate-${userId}`
        : `customer-create-${userId}`;

      const customer = await this.stripe.customers.create(
        { email, name: name ?? undefined },
        { idempotencyKey },
      );

      await trx('users')
        .where('id', userId)
        .update({ stripe_customer_id: customer.id, updated_at: new Date() });

      return customer.id;
    });
  }

  // ── Checkout session (geo-routed) ────────────────────────────────────────────

  async createCheckoutSession(
    userId: string,
    email: string,
    name: string | null | undefined,
    billingCycle: BillingCycle,
    clientIp: string,
    successUrl?: string | null,
    cancelUrl?: string | null,
    countryOverride?: string | null,
  ): Promise<{ checkoutUrl: string; provider: 'stripe' | 'flutterwave'; currency: string }> {
    // Sync existing Stripe subscription first so missed-webhook users are healed
    // before the duplicate check runs (no-op when user has no stripe_customer_id).
    await this.syncSubscriptionFromStripe(userId).catch((err) =>
      this.logger.warn(`Pre-subscribe sync failed (non-fatal): ${(err as Error).message}`),
    );

    const existing = await this.knex('subscriptions')
      .where({ user_id: userId })
      .whereIn('status', ['active', 'trialing'])
      .first();

    if (existing) {
      throw new BadRequestException(
        'You already have an active subscription. Your account should now reflect the correct plan — please refresh the app. If the issue persists, contact support.',
      );
    }

    const country = countryOverride ?? (await this.geoService.detectCountry(clientIp)) ?? 'US';
    const { provider, currency } = getCountryConfig(country);

    this.logger.log(`createCheckoutSession: user=${userId} country=${country} provider=${provider} currency=${currency}`);

    const frontendUrl = this.configService.get<string>('app.frontendUrl') ?? '';
    const resolvedSuccessUrl = successUrl ?? `${frontendUrl}/payment/success`;
    const resolvedCancelUrl = cancelUrl ?? `${frontendUrl}/payment/cancel`;

    if (provider === 'flutterwave') {
      const checkoutUrl = await this.createFlutterwaveCheckout({
        userId, email, name, billingCycle, currency,
        successUrl: resolvedSuccessUrl,
        cancelUrl: resolvedCancelUrl,
      });
      return { checkoutUrl, provider, currency };
    }

    // ── Stripe path ───────────────────────────────────────────────────────────
    await this.getPlanByBillingCycle(billingCycle);
    const stripePriceId = this.getStripePriceId(billingCycle);
    const customerId = await this.getOrCreateStripeCustomer(userId, email, name);

    const baseSuccessUrl = resolvedSuccessUrl;
    const separator = baseSuccessUrl.includes('?') ? '&' : '?';
    const stripeSuccessUrl = `${baseSuccessUrl}${separator}session_id={CHECKOUT_SESSION_ID}`;

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: stripeSuccessUrl,
      cancel_url: resolvedCancelUrl,
      metadata: { userId, billingCycle },
    });

    if (!session.url) throw new Error('Stripe did not return a checkout URL');

    return { checkoutUrl: session.url, provider, currency };
  }

  private async createFlutterwaveCheckout(params: {
    userId: string;
    email: string;
    name: string | null | undefined;
    billingCycle: BillingCycle;
    currency: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string> {
    const { userId, email, name, billingCycle, currency, successUrl } = params;

    const plan = await this.getPlanByBillingCycle(billingCycle);

    // Check for admin override first, then fall back to live FX rate
    const override = await this.knex('subscription_plan_prices')
      .where({ plan_id: plan.id, currency, is_active: true })
      .first();

    let amountMajorUnits: number;
    if (override?.amount_override_cents != null) {
      amountMajorUnits = override.amount_override_cents / 100;
    } else {
      const rate = await this.fxService.getRate('USD', currency);
      const amountCents = this.fxService.convertFromUsdCents(plan.amount_cents, currency, rate);
      amountMajorUnits = amountCents / 100;
    }

    const txRef = `cognix-${userId}-${billingCycle}-${Date.now()}`;

    const link = await this.flutterwaveService.createPaymentLink({
      txRef,
      amount: amountMajorUnits,
      currency,
      email,
      name: name ?? email,
      redirectUrl: successUrl,
      description: `CognIX ${plan.label} subscription`,
      meta: { userId, billingCycle, provider: 'flutterwave' },
    });

    this.logger.log(`Flutterwave checkout created: txRef=${txRef} amount=${amountMajorUnits} ${currency}`);
    return link;
  }

  // ── Flutterwave webhook ────────────────────────────────────────────────────

  async handleFlutterwaveWebhook(
    payload: FlutterwaveWebhookPayload,
    secretHashHeader: string,
  ): Promise<{ received: boolean }> {
    if (!this.flutterwaveService.verifyWebhookSignature(secretHashHeader)) {
      throw new BadRequestException('Invalid Flutterwave webhook signature');
    }

    this.logger.log(`Flutterwave event: ${payload.event}`);

    if (payload.event === 'charge.completed') {
      await this.handleFlutterwaveCharge(payload.data);
    } else {
      this.logger.log(`Unhandled Flutterwave event: ${payload.event}`);
    }

    return { received: true };
  }

  private async handleFlutterwaveCharge(data: FlutterwaveWebhookPayload['data']): Promise<void> {
    if (data.status !== 'successful') {
      this.logger.warn(`Flutterwave charge not successful: ${data.status} — txRef=${data.tx_ref}`);
      return;
    }

    // Always verify server-side — never trust the webhook payload alone
    const verified = await this.flutterwaveService.verifyTransaction(data.id);
    if (verified.status !== 'successful') {
      this.logger.warn(`Flutterwave transaction ${data.id} verification failed: ${verified.status}`);
      return;
    }

    const meta = this.flutterwaveService.parseMeta(data.meta);
    const { userId, billingCycle } = meta;

    if (!userId || !billingCycle) {
      this.logger.warn(`Flutterwave charge missing meta: txRef=${data.tx_ref}`);
      return;
    }

    const user = await this.knex('users').where('id', userId).first();
    if (!user) {
      this.logger.warn(`Flutterwave charge: no user found for userId=${userId}`);
      return;
    }

    // Calculate subscription period based on billing cycle
    const periodDays: Record<string, number> = {
      monthly: 30, quarterly: 90, biannual: 180, yearly: 365,
    };
    const days = periodDays[billingCycle] ?? 30;
    const now = new Date();
    const periodEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    await this.knex('subscriptions')
      .insert({
        user_id: userId,
        stripe_subscription_id: `flw-${data.tx_ref}`, // unique reference in our DB
        stripe_price_id: null,
        billing_cycle: billingCycle,
        status: 'active',
        current_period_start: now,
        current_period_end: periodEnd,
      })
      .onConflict('stripe_subscription_id')
      .merge({
        status: 'active',
        current_period_start: now,
        current_period_end: periodEnd,
        updated_at: new Date(),
      });

    await this.knex('users')
      .where('id', userId)
      .update({ subscription_tier: 'premium', updated_at: new Date() });

    this.logger.log(
      `Flutterwave subscription activated: user=${userId} billingCycle=${billingCycle} periodEnd=${periodEnd.toISOString()}`,
    );
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────────

  async syncSubscriptionFromStripe(userId: string): Promise<{ synced: boolean; status: string | null }> {
    const user = await this.knex('users').where('id', userId).first();

    if (!user?.stripe_customer_id) {
      return { synced: false, status: null };
    }

    let stripeSubscriptions: Stripe.ApiList<Stripe.Subscription>;
    try {
      stripeSubscriptions = await this.stripe.subscriptions.list({
        customer: user.stripe_customer_id,
        status: 'all',
        limit: 10,
      });
    } catch (err) {
      if ((err as any).code === 'resource_missing') {
        this.logger.warn(
          `syncSubscriptionFromStripe: customer ${user.stripe_customer_id} not found in Stripe (test/live mismatch?) — user ${userId}`,
        );
        return { synced: false, status: null };
      }
      throw err;
    }

    const active = stripeSubscriptions.data.find(
      (s) => s.status === 'active' || s.status === 'trialing',
    );

    const latest = active ?? stripeSubscriptions.data[0] ?? null;

    if (!latest) {
      return { synced: false, status: null };
    }

    await this.syncSubscription(latest);

    return { synced: true, status: latest.status };
  }

  async bulkSyncAffectedUsers(): Promise<{
    total: number;
    synced: number;
    alreadyCorrect: number;
    failed: number;
    details: Array<{ userId: string; email: string; result: string }>;
  }> {
    // Target: users who gave Stripe their payment details (have a stripe_customer_id)
    // but whose account is still showing as free — i.e. the webhook never activated them.
    const candidates = await this.knex('users')
      .whereNotNull('stripe_customer_id')
      .where('subscription_tier', 'free')
      .select('id', 'email', 'stripe_customer_id');

    this.logger.log(`bulkSync: found ${candidates.length} candidate users to check`);

    let synced = 0;
    let alreadyCorrect = 0;
    let failed = 0;
    const details: Array<{ userId: string; email: string; result: string }> = [];

    for (const user of candidates) {
      try {
        const result = await this.syncSubscriptionFromStripe(user.id);
        if (result.synced && (result.status === 'active' || result.status === 'trialing')) {
          synced++;
          details.push({ userId: user.id, email: user.email, result: `activated (${result.status})` });
          this.logger.log(`bulkSync: activated user ${user.id} (${user.email}) — sub status: ${result.status}`);
        } else {
          alreadyCorrect++;
          details.push({ userId: user.id, email: user.email, result: `no active Stripe sub (${result.status ?? 'none'})` });
        }
      } catch (err) {
        failed++;
        const msg = (err as Error).message;
        details.push({ userId: user.id, email: user.email, result: `error: ${msg}` });
        this.logger.error(`bulkSync: failed for user ${user.id} — ${msg}`);
      }
    }

    this.logger.log(`bulkSync complete — synced=${synced}, no_sub=${alreadyCorrect}, failed=${failed}`);
    return { total: candidates.length, synced, alreadyCorrect, failed, details };
  }

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
      this.logger.log(
        `Webhook received — size=${payload.length}b, signature=${signature ? 'present' : 'MISSING'}, secret_configured=${!!webhookSecret}`,
      );
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret ?? '');
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Webhook signature verification failed');
    }

    this.logger.log(`Stripe event received: ${event.type}`);

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
      // payment_intent.succeeded fires reliably even when checkout.session.completed
      // or invoice.paid are not subscribed in the Stripe dashboard. We use it as an
      // additional activation path via its linked invoice → subscription.
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        if (pi.invoice) {
          const invoiceId = typeof pi.invoice === 'string' ? pi.invoice : (pi.invoice as Stripe.Invoice).id;
          this.logger.log(`payment_intent.succeeded — retrieving invoice ${invoiceId}`);
          const inv = await this.stripe.invoices.retrieve(invoiceId);
          await this.handlePaymentSucceeded(inv);
        }
        break;
      }
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

    this.logger.log(
      `syncSubscription: sub=${subscription.id}, customer=${customerId}, status=${subscription.status}`,
    );

    const user = await this.knex('users').where('stripe_customer_id', customerId).first();
    if (!user) {
      this.logger.warn(`syncSubscription: no user found for Stripe customer ${customerId} — cannot activate`);
      return;
    }

    this.logger.log(`syncSubscription: matched user ${user.id} (${user.email})`);

    const priceId = subscription.items.data[0]?.price.id ?? null;
    const billingCycle = priceId ? this.getBillingCycleForPriceId(priceId) : null;

    if (priceId && !billingCycle) {
      this.logger.warn(
        `syncSubscription: price ${priceId} not found in STRIPE_PRICE_* env vars — billing_cycle will be null`,
      );
    }

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

    this.logger.log(
      `syncSubscription: user ${user.id} → tier=${isActive ? 'premium' : 'free'}, sub=${subscription.id} upserted`,
    );
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
