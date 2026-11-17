export interface CapturedInterval {
  startMs: number;
  endMs: number;
}

export const MAX_INTERVALS_PER_SESSION = 500;
/** Slack for network latency between the client's capture start and the server receiving session:timing:start. */
export const TIMING_CLOCK_TOLERANCE_MS = 10_000;

/** Upper bound on raw entries examined per report (input abuse guard — not a coverage limit). */
export const MAX_RAW_INTERVALS_EXAMINED = 5 * MAX_INTERVALS_PER_SESSION;

/**
 * Validates, clamps, sorts and MERGES client-reported capture intervals (offsets in ms
 * from the logical session start), and only then applies the storage cap. Overlapping or
 * touching intervals are unioned first, so overlap can never double-count and a cap on the
 * merged list does not drop valid new capture just because the stored list was long.
 * Anything past `maxOffsetMs` (server-observed elapsed + tolerance) is clamped away so a
 * client can't claim more capture than wall-clock time allows.
 *
 * If, after merging, more than MAX_INTERVALS_PER_SESSION disjoint intervals remain, the
 * SHORTEST ones are dropped. That can only understate captured time, never overstate it,
 * and is reported via `truncated` so the caller marks the result partial instead of complete.
 */
export function normalizeIntervals(
  raw: unknown,
  maxOffsetMs: number,
): { intervals: CapturedInterval[]; totalMs: number; truncated: boolean } {
  if (!Array.isArray(raw)) return { intervals: [], totalMs: 0, truncated: false };

  const cleaned: CapturedInterval[] = [];
  for (const item of raw.slice(0, MAX_RAW_INTERVALS_EXAMINED)) {
    if (!item || typeof item !== 'object') continue;
    const s = Number((item as CapturedInterval).startMs);
    const e = Number((item as CapturedInterval).endMs);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    const start = Math.max(0, Math.round(s));
    const end = Math.min(Math.round(e), Math.max(0, Math.floor(maxOffsetMs)));
    if (end > start) cleaned.push({ startMs: start, endMs: end });
  }

  cleaned.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let merged: CapturedInterval[] = [];
  for (const iv of cleaned) {
    const last = merged[merged.length - 1];
    if (last && iv.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, iv.endMs);
    } else {
      merged.push({ ...iv });
    }
  }

  let truncated = false;
  if (merged.length > MAX_INTERVALS_PER_SESSION) {
    truncated = true;
    merged = [...merged]
      .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs)
      .slice(0, MAX_INTERVALS_PER_SESSION)
      .sort((a, b) => a.startMs - b.startMs);
  }
  return { intervals: merged, totalMs: merged.reduce((sum, iv) => sum + (iv.endMs - iv.startMs), 0), truncated };
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
