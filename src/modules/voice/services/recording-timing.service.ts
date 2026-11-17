import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import {
  CapturedInterval,
  TIMING_CLOCK_TOLERANCE_MS,
  normalizeIntervals,
  summarizeTiming,
  toSessionDto,
  SessionTimingRow,
} from '../utils/recording-timing.util';

export const TIMING_CONTRACT_VERSION = 1;
export const DETAIL_SESSION_LIMIT = 200;

/** What the server did with a timing report — returned to the client as an acknowledgement. */
export interface TimingReportResult {
  applied: boolean;
  /** Why it was not (fully) applied, or a note on a partial application. Coarse codes only. */
  reason?: 'invalid_seq' | 'not_found' | 'already_complete' | 'stale' | 'intervals_truncated';
  status?: 'active' | 'ended' | 'interrupted';
  completeness?: 'complete' | 'partial';
}

export interface TimingReport {
  seq: number;
  intervals: unknown;
  final?: boolean;
}

// ─── Read side (shared with ConversationService) ──────────────────────────────

/**
 * List-safe timing aggregate + independent message-date bounds for a page of
 * conversations, in two grouped queries (no N+1). Timing covers known
 * sessions only; bounds come from persisted message created_at and are never
 * used as session boundaries or substituted into the measured total.
 */
export async function fetchTimingSummaries(
  knex: Knex,
  conversations: Array<{ id: string; timing_revision?: number | null }>,
): Promise<Map<string, { timing: Record<string, unknown>; messageDateBounds: Record<string, unknown> }>> {
  const result = new Map<string, { timing: Record<string, unknown>; messageDateBounds: Record<string, unknown> }>();
  if (conversations.length === 0) return result;
  const ids = conversations.map((c) => c.id);

  const [sessionAgg, boundAgg] = await Promise.all([
    knex('conversation_recording_sessions as s')
      .whereIn('s.conversation_id', ids)
      .groupBy('s.conversation_id')
      .select(
        's.conversation_id',
        knex.raw('COUNT(*)::int AS session_count'),
        knex.raw('COALESCE(SUM(s.captured_ms), 0)::bigint AS captured_total'),
        knex.raw(`BOOL_AND(s.completeness = 'complete') AS all_complete`),
        knex.raw(
          `EXISTS (SELECT 1 FROM conversation_messages m
                   WHERE m.conversation_id = s.conversation_id
                     AND m.created_at < MIN(s.started_at)) AS activity_before_first`,
        ),
      ),
    knex('conversation_messages as m')
      .whereIn('m.conversation_id', ids)
      .groupBy('m.conversation_id')
      .select(
        'm.conversation_id',
        knex.raw(`MIN(m.created_at) AT TIME ZONE current_setting('TimeZone') AS first_at`),
        knex.raw(`MAX(m.created_at) AT TIME ZONE current_setting('TimeZone') AS last_at`),
      ),
  ]);

  const sessionsById = new Map<string, any>(sessionAgg.map((r: any) => [r.conversation_id, r]));
  const boundsById = new Map<string, any>(boundAgg.map((r: any) => [r.conversation_id, r]));

  for (const conv of conversations) {
    const s = sessionsById.get(conv.id);
    const b = boundsById.get(conv.id);
    const revision = Number(conv.timing_revision ?? 0);
    const agg = summarizeTiming({
      sessionCount: s ? Number(s.session_count) : 0,
      capturedMsTotal: s ? Number(s.captured_total) : 0,
      allSessionsComplete: s ? Boolean(s.all_complete) : false,
      hasActivityBeforeFirstSession: s ? Boolean(s.activity_before_first) : false,
    });
    result.set(conv.id, {
      timing: { version: TIMING_CONTRACT_VERSION, revision, ...agg },
      messageDateBounds: {
        firstMessageAt: b?.first_at ? new Date(b.first_at).toISOString() : null,
        lastMessageAt: b?.last_at ? new Date(b.last_at).toISOString() : null,
        source: 'message_created_at',
        coverage: 'complete',
        revision,
      },
    });
  }
  return result;
}

/** Detail view: the aggregate from fetchTimingSummaries plus the session rows. */
export async function fetchTimingDetail(
  knex: Knex,
  conversation: { id: string; timing_revision?: number | null },
): Promise<{ timing: Record<string, unknown>; messageDateBounds: Record<string, unknown> }> {
  const [summaries, rows, [{ count }]] = await Promise.all([
    fetchTimingSummaries(knex, [conversation]),
    knex('conversation_recording_sessions')
      .where('conversation_id', conversation.id)
      .orderBy('started_at', 'asc')
      .limit(DETAIL_SESSION_LIMIT)
      .select('id', 'client_session_id', 'started_at', 'ended_at', 'elapsed_ms', 'captured_ms', 'status', 'completeness'),
    knex('conversation_recording_sessions').where('conversation_id', conversation.id).count('id as count'),
  ]);
  const base = summaries.get(conversation.id)!;
  return {
    timing: {
      ...base.timing,
      sessionsCoverage: Number(count) > rows.length ? 'partial' : 'complete',
      sessions: (rows as SessionTimingRow[]).map(toSessionDto),
    },
    messageDateBounds: base.messageDateBounds,
  };
}

// ─── Write side ───────────────────────────────────────────────────────────────

@Injectable()
export class RecordingTimingService {
  private readonly logger = new Logger(RecordingTimingService.name);

  constructor(@Inject('KNEX_CONNECTION') private readonly knex: Knex) {}

  private async bumpRevision(trx: Knex.Transaction, conversationId: string): Promise<void> {
    await trx('conversations').where('id', conversationId).increment('timing_revision', 1);
  }

  /**
   * Idempotently registers a logical session. Called only after fresh
   * microphone capture succeeded (client contract), so failed starts leave no
   * row. A repeat for the same logical id (reconnect) resumes an
   * interrupted session instead of creating a new one; an already-ended
   * session is left untouched.
   */
  async startSession(params: {
    userId: string;
    conversationId: string;
    clientSessionId: string;
    socketId: string;
  }): Promise<{ created: boolean; status: 'active' | 'ended' | 'interrupted' } | null> {
    const { userId, conversationId, clientSessionId, socketId } = params;
    return this.knex.transaction(async (trx) => {
      const owned = await trx('conversations')
        .where({ id: conversationId, user_id: userId })
        .whereNull('deleted_at')
        .forUpdate()
        .first('id');
      if (!owned) return null;

      const existing = await trx('conversation_recording_sessions')
        .where({ conversation_id: conversationId, client_session_id: clientSessionId })
        .forUpdate()
        .first();

      if (existing) {
        if (existing.status === 'ended') return { created: false, status: 'ended' };
        // Resuming after a drop: the disconnect time was only PROVISIONAL (we recorded when
        // the socket went away, not when capture really ended). Clear it, so the eventual
        // final report / close sets the true end and elapsed time.
        await trx('conversation_recording_sessions')
          .where('id', existing.id)
          .update({
            status: 'active',
            socket_id: socketId,
            ...(existing.status === 'interrupted' ? { ended_at: null, elapsed_ms: null } : {}),
            updated_at: trx.fn.now(),
          });
        if (existing.status !== 'active') await this.bumpRevision(trx, conversationId);
        return { created: false, status: 'active' };
      }

      await trx('conversation_recording_sessions').insert({
        conversation_id: conversationId,
        user_id: userId,
        client_session_id: clientSessionId,
        started_at: trx.fn.now(),
        status: 'active',
        completeness: 'partial',
        socket_id: socketId,
      });
      await this.bumpRevision(trx, conversationId);
      return { created: true, status: 'active' };
    });
  }

  /**
   * Applies a cumulative capture report. Duplicate/stale reports (seq not
   * greater than the stored one) are ignored; the stored intervals are the
   * union of old and new so a reordered or repeated report can never shrink
   * or double-count captured time. Offsets are clamped to server-observed
   * elapsed time (+ tolerance).
   */
  async applyReport(params: {
    userId: string;
    conversationId: string;
    clientSessionId: string;
    report: TimingReport;
  }): Promise<TimingReportResult> {
    const { userId, conversationId, clientSessionId, report } = params;
    if (!Number.isInteger(report.seq) || report.seq < 1) return { applied: false, reason: 'invalid_seq' };

    return this.knex.transaction(async (trx) => {
      const row = await trx('conversation_recording_sessions')
        .where({ conversation_id: conversationId, client_session_id: clientSessionId, user_id: userId })
        .forUpdate()
        .first();
      if (!row) return { applied: false, reason: 'not_found' };
      const state = { status: row.status as TimingReportResult['status'], completeness: row.completeness as TimingReportResult['completeness'] };
      if (row.completeness === 'complete') return { applied: false, reason: 'already_complete', ...state };
      if (report.seq <= row.report_seq) return { applied: false, reason: 'stale', ...state };

      const now = Date.now();
      const elapsedMs = now - new Date(row.started_at).getTime();
      const existing: CapturedInterval[] = Array.isArray(row.intervals) ? row.intervals : [];
      const incoming = Array.isArray(report.intervals) ? report.intervals : [];
      const { intervals, totalMs, truncated } = normalizeIntervals(
        [...existing, ...incoming],
        elapsedMs + TIMING_CLOCK_TOLERANCE_MS,
      );

      const update: Record<string, unknown> = {
        intervals: JSON.stringify(intervals),
        captured_ms: totalMs,
        report_seq: report.seq,
        updated_at: trx.fn.now(),
      };
      if (report.final === true) {
        const endedAt = row.ended_at ? new Date(row.ended_at) : new Date(now);
        update.status = 'ended';
        // A report whose intervals exceeded the storage cap is a lower bound, never "complete".
        update.completeness = truncated ? 'partial' : 'complete';
        update.ended_at = endedAt;
        update.elapsed_ms = Math.max(0, endedAt.getTime() - new Date(row.started_at).getTime());
      }
      await trx('conversation_recording_sessions').where('id', row.id).update(update);
      await this.bumpRevision(trx, conversationId);
      return {
        applied: true,
        status: (update.status as TimingReportResult['status']) ?? state.status,
        completeness: (update.completeness as TimingReportResult['completeness']) ?? state.completeness,
        ...(truncated ? { reason: 'intervals_truncated' as const } : {}),
      };
    });
  }

  /**
   * Observed lifecycle close (session:end → 'ended', unexpected socket drop →
   * 'interrupted'). Without a final client report the session stays
   * `partial`. Only the socket currently driving the session may close it, so
   * a stale socket's late disconnect can't mark a session a newer socket
   * already resumed.
   */
  async closeBySocket(params: {
    conversationId: string;
    socketId: string;
    status: 'ended' | 'interrupted';
  }): Promise<void> {
    const { conversationId, socketId, status } = params;
    try {
      await this.knex.transaction(async (trx) => {
        const rows = await trx('conversation_recording_sessions')
          .where({ conversation_id: conversationId, socket_id: socketId, status: 'active' })
          .forUpdate()
          .select('id', 'started_at');
        if (rows.length === 0) return;
        const now = new Date();
        for (const row of rows) {
          await trx('conversation_recording_sessions')
            .where('id', row.id)
            .update({
              status,
              ended_at: now,
              elapsed_ms: Math.max(0, now.getTime() - new Date(row.started_at).getTime()),
              updated_at: trx.fn.now(),
            });
        }
        await this.bumpRevision(trx, conversationId);
      });
    } catch (err) {
      this.logger.error(`Failed to close recording session timing for conversation ${conversationId}`, err as Error);
    }
  }
}
