import { Injectable, Inject, Logger } from '@nestjs/common';
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
  canSend: boolean;
  used: number;
  limit: number;
  remaining: number;
}

@Injectable()
export class GuestSessionService {
  private readonly logger = new Logger(GuestSessionService.name);
  readonly PROMPT_LIMIT = 5;

  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  /**
   * Find an existing guest session or create one atomically.
   * Uses INSERT … ON CONFLICT DO NOTHING so concurrent requests for the same
   * guestSessionId don't race into a unique-constraint violation.
   */
  async findOrCreate(guestSessionId: string): Promise<GuestSession> {
    // Attempt insert; silently skips if the row already exists
    await this.knex('guest_sessions')
      .insert({ id: guestSessionId, prompt_limit: this.PROMPT_LIMIT })
      .onConflict('id')
      .ignore();

    return this.knex('guest_sessions').where('id', guestSessionId).first();
  }

  /**
   * Single DB call that returns everything the gateway needs to gate a prompt.
   * Replaces the previous canSendPrompt() + getPromptStatus() two-call pattern.
   */
  async getStatus(guestSessionId: string): Promise<GuestSessionStatus> {
    const session = await this.findOrCreate(guestSessionId);
    const remaining = Math.max(0, session.prompt_limit - session.prompt_count);
    return {
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
