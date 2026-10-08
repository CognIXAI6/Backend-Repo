import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminPlansService } from './admin-plans.service';
import { FxService } from '../payment/fx.service';
import { EmailModule } from '../email/email.module';
import { FieldsModule } from '../fields/fields.module';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [JwtModule.register({}), EmailModule, FieldsModule, PaymentModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, AdminPlansService, FxService],
})
export class AdminModule {}
