import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Headers,
  RawBodyRequest,
  Get,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentService, BillingCycle } from './payment.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

@Controller('payment')
export class PaymentController {
  constructor(private paymentService: PaymentService) {}

  @Post('subscribe')
  @UseGuards(JwtAuthGuard)
  async createSubscription(
    @CurrentUser() user: any,
    @Body('billingCycle') billingCycle: BillingCycle,
  ) {
    return this.paymentService.createSubscription(
      user.id,
      user.stripeCustomerId,
      billingCycle,
    );
  }

  @Get('/subscription_prices')
  @UseGuards(JwtAuthGuard)
  async getSubscriptionPrices() {
    return this.paymentService.getSubscriptionPrices();
  }

  @Post('cancel')
  @UseGuards(JwtAuthGuard)
  async cancelSubscription(@Body('subscriptionId') subscriptionId: string) {
    return this.paymentService.cancelSubscription(subscriptionId);
  }

  @Post('webhook')
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new Error('Raw body not available');
    }
    return this.paymentService.handleWebhook(req.rawBody, signature);
  }
}
