import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';

export interface GuestSession {
  id: string;
  prompt_count: number;
  prompt_limit: number;
  created_at: Date;
  last_used_at: Date;
}

export interface GuestSessionStatus {
  /** The id this status actually resolved to — see resolveId() below; only differs from the id passed in when that id wasn't a valid UUID. */
  id: string;
  canSend: boolean;
  used: number;
  limit: number;
  remaining: number;
}

// Both frontend clients (apps/web's authSession.ts, apps/mobile's
// guestSession.ts) fall back to a non-UUID string (`${Date.now()}-${random}`)
// whenever `crypto.randomUUID` isn't available in that browser/WebView —
// guest_sessions.id is a strict Postgres `uuid` column, so that fallback
// value fails on insert with "invalid input syntax for type uuid",
// surfacing as SESSION_START_FAILED and permanently blocking that guest
// (every retry mints an equally-invalid id). Validate-and-replace here so a
// guest on an old/incompatible client can still get a working, if
// anonymous-per-visit, trial instead of a hard failure — this is a
// compatibility shim, not a replacement for fixing the generators client-side.
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class GuestSessionService {
  private readonly logger = new Logger(GuestSessionService.name);
  readonly PROMPT_LIMIT = 5;

  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  private resolveId(guestSessionId: string): string {
    if (UUID_V4_REGEX.test(guestSessionId)) return guestSessionId;
    const replacement = randomUUID();
    this.logger.warn(
      `Guest session id "${guestSessionId}" is not a valid UUID (client likely lacks crypto.randomUUID) — using "${replacement}" for this session instead`,
    );
    return replacement;
  }

  /**
   * Find an existing guest session or create one atomically.
   * Uses INSERT … ON CONFLICT DO NOTHING so concurrent requests for the same
   * guestSessionId don't race into a unique-constraint violation.
   */
  async findOrCreate(guestSessionId: string): Promise<GuestSession> {
    const id = this.resolveId(guestSessionId);

    // Attempt insert; silently skips if the row already exists
    await this.knex('guest_sessions')
      .insert({ id, prompt_limit: this.PROMPT_LIMIT })
      .onConflict('id')
      .ignore();

    return this.knex('guest_sessions').where('id', id).first();
  }

  /**
   * Single DB call that returns everything the gateway needs to gate a prompt.
   * Replaces the previous canSendPrompt() + getPromptStatus() two-call pattern.
   */
  async getStatus(guestSessionId: string): Promise<GuestSessionStatus> {
    const session = await this.findOrCreate(guestSessionId);
    const remaining = Math.max(0, session.prompt_limit - session.prompt_count);
    return {
      id: session.id,
      canSend: session.prompt_count < session.prompt_limit,
      used: session.prompt_count,
      limit: session.prompt_limit,
      remaining,
    };
  }

  /**
   * Atomically increment the prompt count and return the updated session.
   */
  async incrementPromptCount(guestSessionId: string): Promise<GuestSession> {
    const [updated] = await this.knex('guest_sessions')
      .where('id', guestSessionId)
      .update({ prompt_count: this.knex.raw('prompt_count + 1'), last_used_at: new Date() })
      .returning('*');

    return updated;
  }
}
