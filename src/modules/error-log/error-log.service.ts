import { Injectable, Inject, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';

export type ErrorSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface LogErrorDto {
  source: string;
  code: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  severity?: ErrorSeverity;
  notified?: boolean;
}

@Injectable()
export class ErrorLogService {
  private readonly logger = new Logger(ErrorLogService.name);

  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  /**
   * Persist an error to the error_logs table.
   * Fire-and-forget — never throws, so callers don't need try/catch.
   */
  log(dto: LogErrorDto): void {
    this.knex('error_logs')
      .insert({
        source: dto.source,
        code: dto.code,
        message: dto.message,
        stack: dto.stack ?? null,
        context: dto.context ? JSON.stringify(dto.context) : null,
        severity: dto.severity ?? 'error',
        notified: dto.notified ?? false,
      })
      .catch((err) => {
        // Last resort — write to console if DB insert itself fails
        this.logger.error(`ErrorLogService DB insert failed: ${err.message}`);
      });
  }

  async getAll(opts: {
    page?: number;
    limit?: number;
    source?: string;
    code?: string;
    severity?: string;
  }) {
    const page = opts.page ?? 1;
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = (page - 1) * limit;

    let query = this.knex('error_logs').whereNull('deleted_at' as any);

    // Filtering (defensive — column existence checked at migration time)
    if (opts.source) query = query.where('source', opts.source);
    if (opts.code) query = query.where('code', opts.code);
    if (opts.severity) query = query.where('severity', opts.severity);

    const [{ count }] = await this.knex('error_logs')
      .modify((q) => {
        if (opts.source) q.where('source', opts.source);
        if (opts.code) q.where('code', opts.code);
        if (opts.severity) q.where('severity', opts.severity);
      })
      .count('id as count');

    const data = await query
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .select('*');

    return {
      data,
      total: Number(count),
      page,
      lastPage: Math.ceil(Number(count) / limit),
    };
  }

  async getStats() {
    const rows = await this.knex('error_logs')
      .select('code', 'severity', 'source')
      .count('id as count')
      .groupBy('code', 'severity', 'source')
      .orderBy('count', 'desc')
      .limit(50);

    return rows;
  }
}
