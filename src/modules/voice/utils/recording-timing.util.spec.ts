import { normalizeIntervals, summarizeTiming, toSessionDto } from './recording-timing.util';

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
    expect(normalizeIntervals('nope', 1000)).toEqual({ intervals: [], totalMs: 0 });
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
