import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';

export type BillingCycle = 'monthly' | 'quarterly' | 'biannual' | 'yearly';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private stripe: Stripe;

  constructor(
    private configService: ConfigService,
    @Inject(KNEX_CONNECTION) private knex: Knex,
  ) {
    const secretKey = this.configService.get<string>('stripe.secretKey');
    if (!secretKey) {
      this.logger.warn('Stripe secret key not configured');
    }
    this.stripe = new Stripe(secretKey || '', {
      apiVersion: '2023-10-16',
    });
  }

  async createCustomer(email: string, name?: string): Promise<Stripe.Customer> {
    return this.stripe.customers.create({
      email,
      name,
    });
  }

  async createSubscription(
    userId: string,
    customerId: string,
    billingCycle: BillingCycle,
  ): Promise<Stripe.Subscription> {
    const priceId = this.getPriceId(billingCycle);

    if (!priceId) {
      throw new BadRequestException('Invalid billing cycle');
    }

    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    // Save subscription to database
    await this.knex('subscriptions').insert({
      user_id: userId,
      stripe_subscription_id: subscription.id,
      stripe_price_id: priceId,
      billing_cycle: billingCycle,
      status: subscription.status,
      current_period_start: new Date(subscription.current_period_start * 1000),
      current_period_end: new Date(subscription.current_period_end * 1000),
    });

    return subscription;
  }

  async cancelSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    const subscription = await this.stripe.subscriptions.cancel(subscriptionId);

    await this.knex('subscriptions')
      .where('stripe_subscription_id', subscriptionId)
      .update({
        status: 'canceled',
        canceled_at: new Date(),
        updated_at: new Date(),
      });

    return subscription;
  }

  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.retrieve(subscriptionId);
  }

  async createPaymentIntent(amount: number, currency = 'usd'): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.create({
      amount: amount * 100, // Convert to cents
      currency,
    });
  }

  async handleWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<{ received: boolean }> {
    const webhookSecret = this.configService.get('stripe.webhookSecret');

    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      throw new BadRequestException('Webhook signature verification failed');
    }

    switch (event.type) {
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.handleSubscriptionUpdate(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_succeeded':
        await this.handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      default:
        this.logger.log(`Unhandled event type: ${event.type}`);
    }

    return { received: true };
  }

  private async handleSubscriptionUpdate(subscription: Stripe.Subscription): Promise<void> {
    await this.knex('subscriptions')
      .where('stripe_subscription_id', subscription.id)
      .update({
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
        updated_at: new Date(),
      });

    // Update user subscription tier
    const sub = await this.knex('subscriptions')
      .where('stripe_subscription_id', subscription.id)
      .first();

    if (sub) {
      const tier = subscription.status === 'active' ? 'premium' : 'free';
      await this.knex('users')
        .where('id', sub.user_id)
        .update({ subscription_tier: tier, updated_at: new Date() });
    }
  }

  private async handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    this.logger.log(`Payment succeeded for invoice ${invoice.id}`);
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    this.logger.warn(`Payment failed for invoice ${invoice.id}`);
  }

  async getSubscriptionPrices() {
    const setting = await this.knex('app_settings').where('key', 'subscription_prices').first();
    return setting?.value;
  }

  private getPriceId(billingCycle: BillingCycle): string | null {
    const prices = this.configService.get('stripe.prices');
    return prices[billingCycle] || null;
  }
}
