import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Req,
  Headers,
  RawBodyRequest,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { PaymentService, BillingCycle } from './payment.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

@Controller('payment')
export class PaymentController {
  constructor(
    private paymentService: PaymentService,
    private configService: ConfigService,
  ) {}

  @Get('plans')
  getPlans() {
    return this.paymentService.getSubscriptionPlans();
  }

  @Get('subscription_prices')
  getSubscriptionPrices() {
    return this.paymentService.getSubscriptionPrices();
  }

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

  // Returns a Stripe-hosted checkout URL. Frontend just opens it — no Stripe.js needed.
  @Post('subscribe')
  @UseGuards(JwtAuthGuard)
  createCheckoutSession(
    @CurrentUser() user: { id: string; email: string; name?: string | null },
    @Body('billingCycle') billingCycle: BillingCycle,
    @Body('successUrl') successUrl?: string,
    @Body('cancelUrl') cancelUrl?: string,
  ) {
    return this.paymentService.createCheckoutSession(
      user.id,
      user.email,
      user.name,
      billingCycle,
      successUrl,
      cancelUrl,
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

  @Post('admin/bulk-sync')
  @HttpCode(HttpStatus.OK)
  bulkSyncAffectedUsers(@Headers('x-admin-secret') secret: string) {
    const expected = this.configService.get<string>('app.adminSecret');
    if (!expected || secret !== expected) {
      throw new ForbiddenException('Invalid admin secret');
    }
    return this.paymentService.bulkSyncAffectedUsers();
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new Error('Raw body not available — ensure rawBody: true in NestFactory.create()');
    }
    return this.paymentService.handleWebhook(req.rawBody, signature);
  }
}
