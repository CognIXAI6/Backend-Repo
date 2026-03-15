import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { UsersService } from '../users/users.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService, UsersService],
  exports: [SettingsService],
})
export class SettingsModule {}