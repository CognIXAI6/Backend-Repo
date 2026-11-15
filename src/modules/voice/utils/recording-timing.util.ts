export interface CapturedInterval {
  startMs: number;
  endMs: number;
}

export const MAX_INTERVALS_PER_SESSION = 500;
/** Slack for network latency between the client's capture start and the server receiving session:timing:start. */
export const TIMING_CLOCK_TOLERANCE_MS = 10_000;

/**
 * Validates, clamps, sorts and merges client-reported capture intervals
 * (offsets in ms from the logical session start). Overlapping/touching
 * intervals are unioned so overlap can never double-count. Anything past
 * `maxOffsetMs` (server-observed elapsed + tolerance) is clamped away so a
 * client can't claim more capture than wall-clock time allows.
 */
export function normalizeIntervals(raw: unknown, maxOffsetMs: number): { intervals: CapturedInterval[]; totalMs: number } {
  if (!Array.isArray(raw)) return { intervals: [], totalMs: 0 };

  const cleaned: CapturedInterval[] = [];
  for (const item of raw.slice(0, MAX_INTERVALS_PER_SESSION)) {
    if (!item || typeof item !== 'object') continue;
    const s = Number((item as CapturedInterval).startMs);
    const e = Number((item as CapturedInterval).endMs);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    const start = Math.max(0, Math.round(s));
    const end = Math.min(Math.round(e), Math.max(0, Math.floor(maxOffsetMs)));
    if (end > start) cleaned.push({ startMs: start, endMs: end });
  }

  cleaned.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: CapturedInterval[] = [];
  for (const iv of cleaned) {
    const last = merged[merged.length - 1];
    if (last && iv.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, iv.endMs);
    } else {
      merged.push({ ...iv });
    }
  }
  return { intervals: merged, totalMs: merged.reduce((sum, iv) => sum + (iv.endMs - iv.startMs), 0) };
}

export type TimingCompleteness = 'complete' | 'partial' | 'unknown';

export interface SessionTimingRow {
  id: string;
  client_session_id: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  elapsed_ms: number | null;
  captured_ms: number;
  status: string;
  completeness: string;
}

const iso = (v: Date | string | null): string | null => (v ? new Date(v).toISOString() : null);

export function toSessionDto(row: SessionTimingRow) {
  return {
    id: row.client_session_id,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    elapsedDurationMs: row.elapsed_ms,
    recordedDurationMs: row.captured_ms,
    status: row.status,
    completeness: row.completeness === 'complete' ? 'complete' : 'partial',
  };
}

/**
 * Conversation-level aggregate over known sessions only.
 * - no sessions            → unknown, total null (never filled from a message-date estimate)
 * - any partial session, or message activity before the first known session
 *   (legacy / unmeasured capture)  → partial (a lower bound)
 * - otherwise              → complete
 */
export function summarizeTiming(input: {
  sessionCount: number;
  capturedMsTotal: number;
  allSessionsComplete: boolean;
  hasActivityBeforeFirstSession: boolean;
}): { recordedDurationMs: number | null; completeness: TimingCompleteness; sessionCount: number } {
  if (input.sessionCount === 0) return { recordedDurationMs: null, completeness: 'unknown', sessionCount: 0 };
  const complete = input.allSessionsComplete && !input.hasActivityBeforeFirstSession;
  return {
    recordedDurationMs: input.capturedMsTotal,
    completeness: complete ? 'complete' : 'partial',
    sessionCount: input.sessionCount,
  };
}
