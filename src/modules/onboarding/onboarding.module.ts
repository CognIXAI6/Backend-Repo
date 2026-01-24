import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { UsersModule } from '@/modules/users/users.module';
import { FieldsModule } from '@/modules/fields/fields.module';
import { SpeakersModule } from '@/modules/speakers/speakers.module';
import { VoiceModule } from '@/modules/voice/voice.module';
import { VerificationModule } from '@/modules/verification/verification.module';

@Module({
  imports: [
    UsersModule,
    FieldsModule,
    SpeakersModule,
    VoiceModule,
    VerificationModule,
  ],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
