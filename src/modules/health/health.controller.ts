import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import { Response } from 'express';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { GIT_SHA, PROCESS_STARTED_AT } from '@/common';

/** Bounded so a stuck connection attempt can't hang a readiness check forever. */
const READINESS_DB_TIMEOUT_MS = 3_000;

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(KNEX_CONNECTION) private knex: Knex) {}

  private async checkDatabase(): Promise<boolean> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.knex.raw('SELECT 1'),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Readiness DB check timed out')), READINESS_DB_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch (error) {
      // Never surface the raw error to a client — this endpoint is unauthenticated.
      this.logger.warn(`Readiness DB check failed: ${(error as Error).message}`);
      return false;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Liveness — is the process/event loop alive. Never touches the database:
   * a slow or dead DB must not make PM2 think the process itself is dead.
   */
  @Get(['', 'live'])
  live() {
    return {
      status: 'alive',
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness — can this instance safely handle user traffic right now.
   * Returns a real 503 when the database is unavailable, so a deployment
   * router (nginx, etc.) can hold back traffic instead of trusting a
   * process that's alive but can't serve a single query.
   */
  @Get('ready')
  async ready(@Res() res: Response) {
    const ok = await this.checkDatabase();
    const body = ok
      ? { status: 'ready', checks: { database: 'ok' } }
      : { status: 'not_ready', checks: { database: 'unavailable' } };
    res.status(ok ? 200 : 503).json(body);
  }

  /**
   * Kept for backward compatibility with anything already polling this route.
   * Previously returned HTTP 200 even when the database was down, and leaked
   * the raw error message — both fixed here without changing the response shape.
   */
  @Get('db')
  async checkDatabaseRoute(@Res() res: Response) {
    const ok = await this.checkDatabase();
    const body = ok
      ? { status: 'ok', database: 'connected', timestamp: new Date().toISOString() }
      : { status: 'error', database: 'disconnected', timestamp: new Date().toISOString() };
    res.status(ok ? 200 : 503).json(body);
  }

  /**
   * Deployment metadata for diagnosing "which build is actually running"
   * during an incident. Deliberately does not depend on the database being
   * up — migration version is best-effort so this endpoint stays useful
   * even during an outage.
   */
  @Get('version')
  async version() {
    let migrationVersion: string | null = null;
    try {
      migrationVersion = await this.knex.migrate.currentVersion();
    } catch {
      // Best-effort only — a DB-down instance should still report its build.
    }

    return {
      gitSha: GIT_SHA,
      processStartedAt: PROCESS_STARTED_AT,
      nodeVersion: process.version,
      migrationVersion,
    };
  }
}
