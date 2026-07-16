import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  UseGuards,
  Req,
  Headers,
  RawBodyRequest,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  Param,
} from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { PaymentService, BillingCycle } from './payment.service';
import { GeoService } from './geo.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

@Controller('payment')
export class PaymentController {
  constructor(
    private paymentService: PaymentService,
    private geoService: GeoService,
    private configService: ConfigService,
  ) {}

  // ── Plans ─────────────────────────────────────────────────────────────────

  // Returns plans priced in the caller's local currency (detected from IP).
  // Pass ?country=NG to override detection (useful for mobile apps that know
  // the user's country from their profile).
  @Get('plans')
  getPlans(@Req() req: Request) {
    const ip = this.geoService.getClientIp(req as any);
    const countryOverride = (req.query['country'] as string) ?? null;
    return this.paymentService.getLocalizedPlans(ip, countryOverride);
  }

  // Legacy endpoint kept for backwards compatibility with existing frontend code.
  @Get('subscription_prices')
  getSubscriptionPrices() {
    return this.paymentService.getSubscriptionPrices();
  }

  // ── User subscription ────────────────────────────────────────────────────

  @Get('my-subscription')
  @UseGuards(JwtAuthGuard)
  getMySubscription(@CurrentUser('id') userId: string) {
    return this.paymentService.getUserSubscription(userId);
  }

  @Get('history')
  @UseGuards(JwtAuthGuard)
  getPaymentHistory(@CurrentUser('id') userId: string) {
    return this.paymentService.getPaymentHistory(userId);
  }

  @Get('sync')
  @UseGuards(JwtAuthGuard)
  syncSubscription(@CurrentUser('id') userId: string) {
    return this.paymentService.syncSubscriptionFromStripe(userId);
  }

  // ── Checkout ─────────────────────────────────────────────────────────────

  // Returns { checkoutUrl, provider, currency }.
  // Frontend just opens checkoutUrl — works identically for Stripe and Flutterwave.
  @Post('subscribe')
  @UseGuards(JwtAuthGuard)
  createCheckoutSession(
    @Req() req: Request,
    @CurrentUser() user: { id: string; email: string; name?: string | null },
    @Body('billingCycle') billingCycle: BillingCycle,
    @Body('successUrl') successUrl?: string,
    @Body('cancelUrl') cancelUrl?: string,
    @Body('country') countryOverride?: string,
  ) {
    const clientIp = this.geoService.getClientIp(req as any);
    return this.paymentService.createCheckoutSession(
      user.id,
      user.email,
      user.name,
      billingCycle,
      clientIp,
      successUrl,
      cancelUrl,
      countryOverride,
    );
  }

  @Post('cancel')
  @UseGuards(JwtAuthGuard)
  cancelSubscription(
    @CurrentUser('id') userId: string,
    @Body('subscriptionId') subscriptionId: string,
  ) {
    return this.paymentService.cancelSubscription(userId, subscriptionId);
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────

  // Stripe webhook — URL registered in the Stripe dashboard.
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new Error('Raw body not available — ensure bodyParser verify callback is set in main.ts');
    }
    return this.paymentService.handleWebhook(req.rawBody, signature);
  }

  // Flutterwave webhook — URL registered in the Flutterwave dashboard.
  // Flutterwave sends the configured secret hash in the verif-hash header.
  @Post('webhook/flutterwave')
  @HttpCode(HttpStatus.OK)
  handleFlutterwaveWebhook(
    @Req() req: Request,
    @Headers('verif-hash') secretHash: string,
  ) {
    return this.paymentService.handleFlutterwaveWebhook(req.body, secretHash);
  }

  // ── Admin endpoints ──────────────────────────────────────────────────────

  private checkAdminSecret(secret: string): void {
    const expected = this.configService.get<string>('app.adminSecret');
    if (!expected || secret !== expected) throw new ForbiddenException('Invalid admin secret');
  }

  // One-time bulk activation for users who paid but weren't activated.
  @Post('admin/bulk-sync')
  @HttpCode(HttpStatus.OK)
  bulkSyncAffectedUsers(@Headers('x-admin-secret') secret: string) {
    this.checkAdminSecret(secret);
    return this.paymentService.bulkSyncAffectedUsers();
  }

  // Shows current live FX rates so the admin can decide on price overrides.
  @Get('admin/fx-rates')
  getFxRates(@Headers('x-admin-secret') secret: string) {
    this.checkAdminSecret(secret);
    return this.paymentService.getFxRatesPreview();
  }

  // Pin a manual price for a specific billing cycle + currency.
  // Example: POST /payment/admin/price-override
  // Body: { billingCycle: "monthly", currency: "NGN", amount: 12000 }
  @Post('admin/price-override')
  setPriceOverride(
    @Headers('x-admin-secret') secret: string,
    @Body('billingCycle') billingCycle: BillingCycle,
    @Body('currency') currency: string,
    @Body('amount') amount: number,
  ) {
    this.checkAdminSecret(secret);
    return this.paymentService.setPriceOverride(billingCycle, currency, amount);
  }

  // Remove a manual override — reverts to live FX rate.
  @Delete('admin/price-override/:billingCycle/:currency')
  clearPriceOverride(
    @Headers('x-admin-secret') secret: string,
    @Param('billingCycle') billingCycle: BillingCycle,
    @Param('currency') currency: string,
  ) {
    this.checkAdminSecret(secret);
    return this.paymentService.clearPriceOverride(billingCycle, currency);
  }
}
