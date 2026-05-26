/**
 * Sentry instrumentation — MUST be the first import in main.ts.
 * Initializing here (before any other modules load) ensures Sentry's
 * OpenTelemetry patches are applied before Express/NestJS are required.
 */
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Capture 20% of traces in production; 100% in development/staging.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,

  // Profile 10% of sampled transactions (CPU flamecharts in Sentry).
  profilesSampleRate: 0.1,

  integrations: [nodeProfilingIntegration()],

  environment: process.env.NODE_ENV ?? 'development',

  // Only enable when DSN is present — keeps local dev clean.
  enabled: Boolean(process.env.SENTRY_DSN),
});
