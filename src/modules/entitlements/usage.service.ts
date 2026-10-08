import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UsageKind } from './entitlements.types';

export interface UsageStatus {
  used: number;
  /** null = unlimited / fair-use — canUse is always true */
  limit: number | null;
  remaining: number | null;
  canUse: boolean;
}

const COLUMN_BY_KIND: Record<UsageKind, string> = {
  messages: 'messages_used',
  voice_seconds: 'voice_seconds_used',
  documents: 'documents_used',
  video_analyses: 'video_analyses_used',
  web_searches: 'web_searches_used',
};

/**
 * Per-user, per-calendar-month usage ledger for authenticated users — the
 * paid-tier counterpart to GuestSessionService's prompt_count/prompt_limit.
 * Period-keyed (one row per user per first-of-month date) so a new month's
 * usage starts at zero on first write; no scheduled reset job needed.
 */
@Injectable()
export class UsageService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  private currentPeriodStart(): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  }

  private async findOrCreateRow(userId: string): Promise<Record<string, any>> {
    const periodStart = this.currentPeriodStart();

    // INSERT ... ON CONFLICT DO NOTHING, same idiom GuestSessionService uses
    // to avoid a unique-constraint race between concurrent requests.
    await this.knex('usage_counters')
      .insert({ user_id: userId, period_start: periodStart })
      .onConflict(['user_id', 'period_start'])
      .ignore();

    return this.knex('usage_counters').where({ user_id: userId, period_start: periodStart }).first();
  }

  async getStatus(userId: string, kind: UsageKind, limit: number | null): Promise<UsageStatus> {
    const row = await this.findOrCreateRow(userId);
    return this.statusFromRow(row, kind, limit);
  }

  private statusFromRow(row: Record<string, any>, kind: UsageKind, limit: number | null): UsageStatus {
    const used = Number(row[COLUMN_BY_KIND[kind]] ?? 0);
    if (limit === null) return { used, limit: null, remaining: null, canUse: true };
    const remaining = Math.max(0, limit - used);
    return { used, limit, remaining, canUse: used < limit };
  }

  /**
   * All five counters for this month in a single round trip — used by the
   * "my plan" endpoint so the client can render usage against every cap at
   * once instead of issuing five separate getStatus() calls.
   */
  async getAllStatuses(
    userId: string,
    limits: Record<UsageKind, number | null>,
  ): Promise<Record<UsageKind, UsageStatus>> {
    const row = await this.findOrCreateRow(userId);
    const kinds = Object.keys(COLUMN_BY_KIND) as UsageKind[];
    return Object.fromEntries(kinds.map((kind) => [kind, this.statusFromRow(row, kind, limits[kind])])) as Record<
      UsageKind,
      UsageStatus
    >;
  }

  /**
   * Atomically increments `kind` by `amount` only if doing so stays within
   * `limit` — a single conditional UPDATE, not a read-then-write, so two
   * concurrent requests can't both slip past the cap.
   */
  async tryConsume(
    userId: string,
    kind: UsageKind,
    amount: number,
    limit: number | null,
  ): Promise<UsageStatus> {
    if (amount <= 0) return this.getStatus(userId, kind, limit);

    const column = COLUMN_BY_KIND[kind];
    const periodStart = this.currentPeriodStart();

    if (limit === null) {
      // Unlimited/fair-use — still tracked for admin visibility, never gated.
      await this.findOrCreateRow(userId);
      const [updated] = await this.knex('usage_counters')
        .where({ user_id: userId, period_start: periodStart })
        .update({ [column]: this.knex.raw(`${column} + ?`, [amount]), updated_at: new Date() })
        .returning('*');
      return { used: Number(updated[column]), limit: null, remaining: null, canUse: true };
    }

    await this.findOrCreateRow(userId);

    const updated = await this.knex('usage_counters')
      .where({ user_id: userId, period_start: periodStart })
      .andWhere(this.knex.raw(`${column} + ? <= ?`, [amount, limit]))
      .update({ [column]: this.knex.raw(`${column} + ?`, [amount]), updated_at: new Date() })
      .returning('*');

    if (updated.length > 0) {
      const used = Number(updated[0][column]);
      return { used, limit, remaining: Math.max(0, limit - used), canUse: true };
    }

    // Conditional update matched no row — already at/over the cap.
    const current = await this.knex('usage_counters')
      .where({ user_id: userId, period_start: periodStart })
      .first();
    const used = Number(current?.[column] ?? 0);
    return { used, limit, remaining: Math.max(0, limit - used), canUse: false };
  }
}
