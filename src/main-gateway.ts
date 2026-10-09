// ⚠️  Must be the very first import — Sentry patches Node.js modules at load time.
import './instrument';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { GatewayAppModule } from './app-gateway.module';
import * as bodyParser from 'body-parser';
import { correlationIdMiddleware } from './common/middleware/correlation-id.middleware';
import * as Sentry from '@sentry/nestjs';

// Same fail-fast rationale as main.ts: per Node's own docs it is not safe to
// resume after uncaughtException. Restarting this process only drops live
// voice sessions (clients reconnect) — it no longer also takes the REST API
// down with it, which was the whole point of splitting these two apart.
process.on('uncaughtException', (err: Error) => {
  Sentry.captureException(err, { tags: { source: 'uncaughtException', process: 'voice-gateway' } });
  console.error('[uncaughtException] Re-throwing fatal error:', err);
  throw err;
});

process.on('unhandledRejection', (reason: unknown) => {
  Sentry.captureException(reason, { tags: { source: 'unhandledRejection', process: 'voice-gateway' } });
  console.error('[unhandledRejection]', reason);
});

async function bootstrap() {
  const app = await NestFactory.create(GatewayAppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  // Kept even though this process's main job is Socket.IO, not REST: a few
  // shared modules' REST controllers (FieldsController, DocumentController,
  // etc.) still get registered here as an accepted side effect of reusing
  // those modules for their services — see voice-gateway.module.ts. Nothing
  // external ever reaches them (nginx only routes /socket.io/* here), but
  // keeping the same request-handling middleware stack means they behave
  // identically if anything ever does hit them directly (e.g. during
  // local dev against this port).
  app.use(correlationIdMiddleware);

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
  const port = configService.get('app.voiceGatewayPort');

  // Socket.IO manages its own CORS via @WebSocketGateway's `cors` option
  // (already permissive — see voice.gateway.ts) independent of this. This
  // just covers the same stray-REST-route case the middleware comment above
  // describes.
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

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(port);

  // Same fail-fast timeout as main.ts, same scope caveat: governs the HTTP
  // request/response cycle only — a Socket.IO connection, once upgraded,
  // is no longer driven through this path, so live voice sessions are
  // unaffected no matter how long they run.
  const httpServer = app.getHttpServer();
  httpServer.setTimeout(30_000, (socket: import('net').Socket) => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    }
  });

  const logger = app.get(Logger);
  logger.log(`🎙️  CognIX AI voice-gateway running on: http://localhost:${port}`);
}

bootstrap();
