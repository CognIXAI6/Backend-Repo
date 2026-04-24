import { Module, Global, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import knex, { Knex } from 'knex';

export const KNEX_CONNECTION = 'KNEX_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: KNEX_CONNECTION,
      useFactory: async (configService: ConfigService): Promise<Knex> => {
        const logger = new Logger('DatabaseModule');
        
        const isProduction = configService.get('app.nodeEnv') === 'production';

        const connection = knex({
          client: 'pg',
          connection: {
            host: configService.get('database.host'),
            port: configService.get('database.port'),
            database: configService.get('database.name'),
            user: configService.get('database.user'),
            password: configService.get('database.password'),
            ssl: isProduction ? { rejectUnauthorized: false } : false,
          },
          pool: {
            min: 2,
            max: 50,
            // Kill idle connections after 30s to avoid stale socket errors
            idleTimeoutMillis: 30000,
            // Reap connections that have been checked out for > 60s (hung queries)
            reapIntervalMillis: 1000,
          },
          acquireConnectionTimeout: 10000,
        });

        // Test connection
        try {
          await connection.raw('SELECT 1');
          logger.log('✅ Database connected successfully');
        } catch (error) {
          logger.error('❌ Database connection failed:', error);
          // Don't throw - let the app start and handle errors per-request
        }

        return connection;
      },
      inject: [ConfigService],
    },
  ],
  exports: [KNEX_CONNECTION],
})
export class DatabaseModule {}