import { MAX_INTERVALS_PER_SESSION, normalizeIntervals, summarizeTiming, toSessionDto } from './recording-timing.util';

describe('normalizeIntervals', () => {
  it('merges overlapping and touching intervals so overlap never double-counts', () => {
    const r = normalizeIntervals(
      [{ startMs: 0, endMs: 5000 }, { startMs: 4000, endMs: 9000 }, { startMs: 9000, endMs: 10000 }, { startMs: 20000, endMs: 25000 }],
      60_000,
    );
    expect(r.intervals).toEqual([{ startMs: 0, endMs: 10000 }, { startMs: 20000, endMs: 25000 }]);
    expect(r.totalMs).toBe(15000);
  });

  it('clamps to the server-observed maximum offset', () => {
    const r = normalizeIntervals([{ startMs: 0, endMs: 3_600_000 }], 30_000);
    expect(r.totalMs).toBe(30_000);
  });

  it('drops malformed, negative-length and non-finite entries', () => {
    const r = normalizeIntervals(
      [null, 'x', { startMs: 'a', endMs: 5 }, { startMs: 10, endMs: 10 }, { startMs: 20, endMs: 5 }, { startMs: NaN, endMs: 9 }, { startMs: -50, endMs: 1000 }],
      60_000,
    );
    expect(r.intervals).toEqual([{ startMs: 0, endMs: 1000 }]);
  });

  it('returns empty for non-arrays', () => {
    expect(normalizeIntervals('nope', 1000)).toEqual({ intervals: [], totalMs: 0, truncated: false });
  });
});

describe('normalizeIntervals — merge BEFORE the storage cap', () => {
  const disjoint = (n: number, len = 100, gap = 1_000) => Array.from({ length: n }, (_, i) => ({ startMs: i * (len + gap), endMs: i * (len + gap) + len }));

  it('a stored list at the cap plus an overlapping/adjacent report is merged, not truncated — nothing is dropped', () => {
    const stored = disjoint(MAX_INTERVALS_PER_SESSION);
    const r = normalizeIntervals([...stored, { startMs: 50, endMs: 1_200 }], 10_000_000); // bridges interval 0 and 1
    expect(r.truncated).toBe(false);
    expect(r.intervals.length).toBe(MAX_INTERVALS_PER_SESSION - 1);
    expect(r.intervals[0]).toEqual({ startMs: 0, endMs: 1_200 });
  });

  it('valid NEW capture is never discarded just because the stored list is long (the old first-500 slice dropped it)', () => {
    const stored = disjoint(MAX_INTERVALS_PER_SESSION, 100);
    const incoming = { startMs: 9_000_000, endMs: 9_060_000 }; // one long new interval, disjoint
    const r = normalizeIntervals([...stored, incoming], 20_000_000);
    expect(r.intervals).toContainEqual(incoming);
    expect(r.truncated).toBe(true); // 501 disjoint intervals → the cap applies…
    expect(r.intervals).toHaveLength(MAX_INTERVALS_PER_SESSION);
    // …by dropping the SHORTEST, which can only understate captured time
    const keptTotal = r.totalMs;
    const fullTotal = 500 * 100 + 60_000;
    expect(keptTotal).toBeLessThanOrEqual(fullTotal);
    expect(keptTotal).toBe(fullTotal - 100); // exactly one 100ms interval lost
  });

  it('over the cap by a lot: keeps the longest, stays sorted, reports truncated, total equals what is kept', () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ startMs: i * 10_000, endMs: i * 10_000 + 100 + (i % 7) * 50 }));
    const r = normalizeIntervals(many, 100_000_000);
    expect(r.truncated).toBe(true);
    expect(r.intervals).toHaveLength(MAX_INTERVALS_PER_SESSION);
    expect([...r.intervals].sort((a, b) => a.startMs - b.startMs)).toEqual(r.intervals);
    expect(r.totalMs).toBe(r.intervals.reduce((n, iv) => n + iv.endMs - iv.startMs, 0));
    expect(Math.min(...r.intervals.map((iv) => iv.endMs - iv.startMs))).toBeGreaterThanOrEqual(100);
  });

  it('an under-cap report is never flagged truncated', () => {
    expect(normalizeIntervals(disjoint(10), 1_000_000).truncated).toBe(false);
  });
});

describe('summarizeTiming', () => {
  it('is unknown with a null total when there are no known sessions', () => {
    expect(summarizeTiming({ sessionCount: 0, capturedMsTotal: 0, allSessionsComplete: false, hasActivityBeforeFirstSession: true })).toEqual({
      recordedDurationMs: null, completeness: 'unknown', sessionCount: 0,
    });
  });
  it('is partial when earlier activity predates the first known session', () => {
    expect(summarizeTiming({ sessionCount: 1, capturedMsTotal: 45000, allSessionsComplete: true, hasActivityBeforeFirstSession: true }).completeness).toBe('partial');
  });
  it('is partial when any session is partial', () => {
    expect(summarizeTiming({ sessionCount: 2, capturedMsTotal: 10, allSessionsComplete: false, hasActivityBeforeFirstSession: false }).completeness).toBe('partial');
  });
  it('is complete only when every session is complete and nothing predates them', () => {
    expect(summarizeTiming({ sessionCount: 2, capturedMsTotal: 10, allSessionsComplete: true, hasActivityBeforeFirstSession: false }).completeness).toBe('complete');
  });
});

describe('toSessionDto', () => {
  it('maps a row to the contract shape with ISO timestamps', () => {
    const dto = toSessionDto({
      id: 'x', client_session_id: 'logical-2', started_at: new Date('2026-11-14T09:00:00Z'), ended_at: null,
      elapsed_ms: null, captured_ms: 45000, status: 'interrupted', completeness: 'partial',
    });
    expect(dto).toEqual({
      id: 'logical-2', startedAt: '2026-11-14T09:00:00.000Z', endedAt: null, elapsedDurationMs: null,
      recordedDurationMs: 45000, status: 'interrupted', completeness: 'partial',
    });
  });
});
