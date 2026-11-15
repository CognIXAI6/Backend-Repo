import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';

// Request/response headers carry bearer tokens and cookies; pino-http logs them by default.
export const REDACT = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'req.headers["x-auth-token"]',
    'res.headers["set-cookie"]',
  ],
  censor: '[redacted]',
};

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      useFactory: (configService: ConfigService) => {
        const isProduction = configService.get('app.nodeEnv') === 'production';

        if (isProduction) {
          return {
            pinoHttp: {
              level: 'info',
              autoLogging: true,
              redact: REDACT,
            },
          };
        }

        return {
          pinoHttp: {
            level: 'debug',
            redact: REDACT,
            transport: {
              target: require.resolve('pino-pretty'),
              options: {
                colorize: true,
                singleLine: false,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
              },
            },
            autoLogging: true,
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
})
export class LoggerModule {}