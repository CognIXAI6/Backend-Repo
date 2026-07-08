// ⚠️  Must be the very first import — Sentry patches Node.js modules at load time.
import './instrument';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';

// Prevent the Deepgram SDK's internal ws.WebSocket from crashing the process
// when it emits an unhandled 'error' event during a connection timeout / close race.
// NestJS's own exception filters do not cover Node.js-level EventEmitter errors.
import * as Sentry from '@sentry/nestjs';

process.on('uncaughtException', (err: Error) => {
  if (
    err.message.includes('WebSocket was closed before the connection was established') ||
    err.message.includes('WebSocket is not open')
  ) {
    console.error('[DeepgramSDK] Suppressed uncaught WS error:', err.message);
    return;
  }
  Sentry.captureException(err, { tags: { source: 'uncaughtException' } });
  console.error('[uncaughtException] Re-throwing fatal error:', err);
  throw err;
});

process.on('unhandledRejection', (reason: unknown) => {
  Sentry.captureException(reason, { tags: { source: 'unhandledRejection' } });
  console.error('[unhandledRejection]', reason);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // Use Pino logger
  app.useLogger(app.get(Logger));

  // Single JSON body parser: 15 MB limit + rawBody capture for Stripe webhook
  // verification. Must be registered once — multiple body parsers on the same
  // route consume the stream and leave req.rawBody undefined.
  app.use(
    bodyParser.json({
      limit: '15mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(bodyParser.urlencoded({ limit: '15mb', extended: true }));
  const configService = app.get(ConfigService);
  const port = configService.get('app.port');
  const apiPrefix = configService.get('app.apiPrefix');
  const apiVersion = configService.get('app.apiVersion');
  // CORS
  const frontendUrl = configService.get<string>('app.frontendUrl') ?? '';
  const allowedOrigins: string[] = [
    'http://localhost:3000',
    'http://localhost:3001',
    ...new Set([
      frontendUrl,
      frontendUrl.startsWith('https://www.')
        ? frontendUrl.replace('https://www.', 'https://')
        : frontendUrl.replace('https://', 'https://www.'),
    ].filter(Boolean)),
  ];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Global prefix: /api
  app.setGlobalPrefix(apiPrefix);

  // API versioning: /api/v1
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: apiVersion.replace('v', ''),
  });

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`🚀 CognIX AI API running on: http://localhost:${port}`);
  logger.log(`📚 API Version: ${apiVersion}`);
  logger.log(`🔗 Base URL: http://localhost:${port}/${apiPrefix}/${apiVersion}`);
}

bootstrap();
