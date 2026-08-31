import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { ConversationService } from './conversation.service';

/**
 * Backend-owned replacement for client-triggered conversation cleanup.
 * DELETE /conversations/empty stays live (the frontend still calls it on
 * every app open and isn't being changed), but this job is the intended
 * long-term owner: it runs system-wide, independent of any client request,
 * so cleanup happens even for guest sessions or a client build that never
 * calls the endpoint.
 */
@Injectable()
export class ConversationCleanupService {
  private readonly logger = new Logger(ConversationCleanupService.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: Knex,
    private readonly conversationService: ConversationService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async runScheduledCleanup(): Promise<void> {
    const startedAt = Date.now();
    const gracePeriodHours = this.configService.get<number>('cleanup.gracePeriodHours') ?? 24;
    const dryRun = this.configService.get<boolean>('cleanup.dryRun') ?? true;
    const batchSize = this.configService.get<number>('cleanup.batchSize') ?? 200;

    try {
      const result = await this.knex.transaction(async (trx) => {
        // Lock candidate rows so a concurrent worker (if this ever scales
        // beyond the current single instance) can't double-process them.
        const candidates = await this.conversationService
          .buildCleanupCandidatesQuery(trx, { olderThanHours: gracePeriodHours })
          .select('id')
          .limit(batchSize)
          .forUpdate()
          .skipLocked();

        const candidateIds = candidates.map((row: { id: string }) => row.id);
        if (candidateIds.length === 0) {
          return { candidates: 0, deleted: 0 };
        }

        if (dryRun) {
          return { candidates: candidateIds.length, deleted: 0 };
        }

        // Re-verify eligibility at delete time, scoped to just the locked
        // IDs — closes the race window between selecting candidates and
        // deleting them (a child row could have been created in between).
        const deleted = await this.conversationService
          .buildCleanupCandidatesQuery(trx, { olderThanHours: gracePeriodHours })
          .whereIn('id', candidateIds)
          .delete();

        return { candidates: candidateIds.length, deleted };
      });

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `Cleanup run complete: candidates=${result.candidates} deleted=${result.deleted} ` +
        `dryRun=${dryRun} durationMs=${durationMs}`,
      );
    } catch (err) {
      this.logger.error(`Cleanup run failed: ${(err as Error).message}`, (err as Error).stack);
    }
  }
}
