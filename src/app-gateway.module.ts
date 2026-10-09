import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';

import {
  appConfig,
  databaseConfig,
  redisConfig,
  jwtConfig,
  emailConfig,
  cloudinaryConfig,
  stripeConfig,
  clerkConfig,
  flutterwaveConfig,
  geoConfig,
  notificationsConfig,
  cleanupConfig,
  chatConfig,
} from './config';

import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggerModule } from './common/logger/logger.module';
import { DatabaseModule } from './database/database.module';
import { EntitlementsModule } from './modules/entitlements/entitlements.module';
import { HealthModule } from './modules/health/health.module';
import { VoiceGatewayModule } from './modules/voice/voice-gateway.module';

/**
 * Root module for the voice-gateway process (see main-gateway.ts) — the
 * counterpart to AppModule (the REST API process, main.ts). Deliberately
 * does NOT import ScheduleModule.forRoot(): VoiceModule's
 * ConversationCleanupService (and anything else with an @Cron/@Interval)
 * still gets instantiated here as a plain provider via VoiceGatewayModule
 * → VoiceModule, but without ScheduleModule registered in this process's
 * graph, @nestjs/schedule never wires its timer up — so scheduled jobs run
 * exactly once, on the API process, never doubled up here.
 *
 * Also omits every REST-only feature module (Auth, Payment, Admin, Chat,
 * Conversations, Resources, Settings, Onboarding, Verification) — this
 * process only needs to serve Socket.IO.
 */
@Module({
  imports: [
    SentryModule.forRoot(),
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
        clerkConfig,
        flutterwaveConfig,
        geoConfig,
        notificationsConfig,
        cleanupConfig,
        chatConfig,
      ],
    }),
    LoggerModule,
    DatabaseModule,
    EntitlementsModule,
    VoiceGatewayModule,
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
export class GatewayAppModule {}
