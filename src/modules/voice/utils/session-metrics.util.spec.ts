import { SESSION_BOUNDS, createSessionMetrics, recordHighWater, snapshotMetrics } from './session-metrics.util';

describe('session metrics', () => {
  const sizes = (over: Partial<Record<string, number>> = {}) => ({
    multiHistoryTurns: 1, dualHistoryTurns: 2, confidenceSamples: 3, pendingTurns: 4, pendingChars: 5,
    audioBufferBytes: 6, speakerAudioBytes: 7, recoveryBufferBytes: 8, recoveryBufferChunks: 9, inFlightTurns: 10, ...over,
  });

  it('keeps the maximum seen for every dimension and counts samples', () => {
    const m = createSessionMetrics();
    recordHighWater(m, sizes());
    recordHighWater(m, sizes({ pendingTurns: 2, audioBufferBytes: 60 }));
    expect(m.samples).toBe(2);
    expect(m.highWater.pendingTurns).toBe(4);
    expect(m.highWater.audioBufferBytes).toBe(60);
  });

  it('snapshot is JSON-safe and holds numbers only (no free text can ride along)', () => {
    const m = createSessionMetrics();
    recordHighWater(m, sizes());
    const snap = snapshotMetrics(m);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    const flat = [...Object.values(snap.highWater), ...Object.values(snap.boundHits), snap.samples, snap.trimmedHistoryTurns];
    expect(flat.every((v) => typeof v === 'number')).toBe(true);
  });

  it('documents the bounds', () => {
    expect(SESSION_BOUNDS.MAX_MULTI_HISTORY_TURNS).toBeGreaterThan(60); // AI context window is 60
    expect(SESSION_BOUNDS.MAX_DUAL_HISTORY_TURNS).toBeGreaterThan(40); // AI context window is 40
  });
});
