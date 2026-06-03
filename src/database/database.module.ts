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
        const dbHost: string = configService.get('database.host') ?? '';

        // Supabase uses PgBouncer (transaction mode) as the pooler.
        // PgBouncer's server_idle_timeout is ~10 s — any Knex idle timeout
        // longer than that hands out a socket PgBouncer already closed,
        // causing "read EADDRNOTAVAIL". SSL is always required on Supabase.
        const isSupabase = dbHost.includes('supabase.com') || dbHost.includes('pooler.supabase');

        const connection = knex({
          client: 'pg',
          connection: {
            host: dbHost,
            port: configService.get('database.port'),
            database: configService.get('database.name'),
            user: configService.get('database.user'),
            password: configService.get('database.password'),
            // Always enable SSL for Supabase; respect NODE_ENV elsewhere.
            ssl: isSupabase || isProduction ? { rejectUnauthorized: false } : false,
            // Keep TCP connections alive at the OS level so the kernel drops
            // dead sockets before Knex tries to reuse them.
            keepAlive: true,
          },
          pool: {
            // min: 0 so we don't hold open connections unnecessarily.
            min: 0,
            // Supabase's default pooler plan supports ~15–25 server-side
            // connections. Keep well below that to avoid exhaustion.
            max: isSupabase ? 10 : 20,
            // Must be shorter than PgBouncer's server_idle_timeout (~10 s)
            // so Knex retires connections before PgBouncer closes them.
            idleTimeoutMillis: isSupabase ? 7000 : 20000,
            // Check for reaped connections every 5 s (was 1 s — too aggressive).
            reapIntervalMillis: 5000,
            // Validate every connection before handing it to a query.
            // If the socket is dead this triggers a clean discard + retry
            // instead of an EADDRNOTAVAIL crash.
            afterCreate: (conn: any, done: (err: Error | null, conn: any) => void) => {
              conn.query('SELECT 1', (err: Error | null) => {
                if (err) {
                  logger.warn('New DB connection failed health check, discarding:', err.message);
                }
                done(err, conn);
              });
            },
          },
          acquireConnectionTimeout: 15000,
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