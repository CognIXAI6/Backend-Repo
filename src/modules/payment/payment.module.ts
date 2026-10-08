import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { GeoService } from './geo.service';
import { FxService } from './fx.service';
import { FlutterwaveService } from './flutterwave.service';
import { StripeSyncService } from './stripe-sync.service';

@Module({
  controllers: [PaymentController],
  providers: [PaymentService, GeoService, FxService, FlutterwaveService, StripeSyncService],
  exports: [PaymentService, StripeSyncService],
})
export class PaymentModule {}
