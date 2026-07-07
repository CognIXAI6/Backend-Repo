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

  // Returns a Stripe-hosted checkout URL. Frontend just opens it — no Stripe.js needed.
  @Post('subscribe')
  @UseGuards(JwtAuthGuard)
  createCheckoutSession(
    @CurrentUser() user: { id: string; email: string; name?: string | null },
    @Body('billingCycle') billingCycle: BillingCycle,
  ) {
    return this.paymentService.createCheckoutSession(
      user.id,
      user.email,
      user.name,
      billingCycle,
    );
  }

  @Post('cancel')
  @UseGuards(JwtAuthGuard)
  cancelSubscription(@Body('subscriptionId') subscriptionId: string) {
    return this.paymentService.cancelSubscription(subscriptionId);
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
