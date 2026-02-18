import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import * as express from 'express';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  // Use Pino logger
  app.useLogger(app.get(Logger));
  // Increase JSON body size limit to 15MB
  app.use(bodyParser.json({ limit: '15mb' }));
  app.use(bodyParser.urlencoded({ limit: '15mb', extended: true }));
  
  // If you're also handling raw data
  app.use(bodyParser.raw({ limit: '15mb' }));
  const configService = app.get(ConfigService);
  const port = configService.get('app.port');
  const apiPrefix = configService.get('app.apiPrefix');
  const apiVersion = configService.get('app.apiVersion');
  const isProduction = configService.get('app.nodeEnv') === 'production';

  // CORS
  app.enableCors({
    origin: isProduction
      ? configService.get<string>('app.frontendUrl')
      : true,
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

  // Raw body for Stripe webhooks
  app.use(
    express.json({
      verify: (req: any, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`🚀 CognIX AI API running on: http://localhost:${port}`);
  logger.log(`📚 API Version: ${apiVersion}`);
  logger.log(`🔗 Base URL: http://localhost:${port}/${apiPrefix}/${apiVersion}`);
}

bootstrap();
