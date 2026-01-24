import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';

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
            },
          };
        }

        return {
          pinoHttp: {
            level: 'debug',
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