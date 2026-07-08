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
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentService, BillingCycle } from './payment.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

@Controller('payment')
export class PaymentController {
  constructor(private paymentService: PaymentService) {}

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

  @Post('sync')
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
