// ⚠️  Must be the very first import — Sentry patches Node.js modules at load time.
import './instrument';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { correlationIdMiddleware } from './common/middleware/correlation-id.middleware';

// NestJS's own exception filters do not cover Node.js-level EventEmitter
// errors. The Deepgram SDK's WS-close race that used to land here is now
// absorbed at its source in DeepgramService (see the permanent no-op error
// listener in createLiveSession), so this handler stays a plain fail-fast:
// log to Sentry, then re-throw so PM2 restarts the process. Per Node's own
// docs, it is not safe to resume normal operation after uncaughtException.
import * as Sentry from '@sentry/nestjs';

process.on('uncaughtException', (err: Error) => {
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

  // Stamp every request with a correlation ID before anything else runs, so
  // it's available to every downstream handler and to the exception filter.
  app.use(correlationIdMiddleware);

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

  // A stuck REST request (e.g. waiting on a starved DB-pool connection)
  // previously had no cap — it just held the connection open until the
  // client's own 15s axios timeout gave up client-side, with nothing
  // server-side ever failing fast, logging, or freeing the connection.
  // This forces a definite end: Node emits 'timeout' on the socket, Express
  // writes a real 503 the client's retry logic can react to immediately,
  // and the connection/pool slot gets freed instead of sitting open.
  // Node's socket timeout only governs the HTTP request/response cycle —
  // once Socket.IO upgrades a connection to a WebSocket, that socket is no
  // longer driven through this path, so the voice gateway is unaffected.
  const httpServer = app.getHttpServer();
  httpServer.setTimeout(30_000, (socket: import('net').Socket) => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    }
  });

  const logger = app.get(Logger);
  logger.log(`🚀 CognIX AI API running on: http://localhost:${port}`);
  logger.log(`📚 API Version: ${apiVersion}`);
  logger.log(`🔗 Base URL: http://localhost:${port}/${apiPrefix}/${apiVersion}`);
}

bootstrap();
