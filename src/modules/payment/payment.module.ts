import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { GeoService } from './geo.service';
import { FxService } from './fx.service';
import { FlutterwaveService } from './flutterwave.service';

@Module({
  controllers: [PaymentController],
  providers: [PaymentService, GeoService, FxService, FlutterwaveService],
  exports: [PaymentService],
})
export class PaymentModule {}
