import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SpeakersController } from './speakers.controller';
import { SpeakersService } from './speakers.service';
import { VoiceVerificationService } from '../voice/services/voice-verification.service';

@Module({
  imports: [ConfigModule],
  controllers: [SpeakersController],
  providers: [SpeakersService, VoiceVerificationService],
  exports: [SpeakersService],
})
export class SpeakersModule {}
