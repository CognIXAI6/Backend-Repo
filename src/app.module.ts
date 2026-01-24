import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';

// Config
import {
  appConfig,
  databaseConfig,
  redisConfig,
  jwtConfig,
  emailConfig,
  cloudinaryConfig,
  stripeConfig,
} from './config';

// Common
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggerModule } from './common/logger/logger.module';

// Database
import { DatabaseModule } from './database/database.module';

// Modules
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { EmailModule } from './modules/email/email.module';
import { UploadModule } from './modules/upload/upload.module';
import { PaymentModule } from './modules/payment/payment.module';
import { FieldsModule } from './modules/fields/fields.module';
import { VerificationModule } from './modules/verification/verification.module';
import { SpeakersModule } from './modules/speakers/speakers.module';
import { VoiceModule } from './modules/voice/voice.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        redisConfig,
        jwtConfig,
        emailConfig,
        cloudinaryConfig,
        stripeConfig,
      ],
    }),
    LoggerModule,
    DatabaseModule,
    EmailModule,
    UploadModule,
    AuthModule,
    UsersModule,
    PaymentModule,
    FieldsModule,
    VerificationModule,
    SpeakersModule,
    VoiceModule,
    OnboardingModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}