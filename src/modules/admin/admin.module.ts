import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { FxService } from '../payment/fx.service';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [JwtModule.register({}), EmailModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, FxService],
})
export class AdminModule {}
