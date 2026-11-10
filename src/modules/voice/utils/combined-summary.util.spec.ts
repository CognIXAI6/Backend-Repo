import { buildCombinedSummary } from './combined-summary.util';

describe('buildCombinedSummary', () => {
  const part = (title: string, day: number) => ({
    title,
    topic: `${title} topic`,
    sections: [{ heading: 'Summary', content: `${title} summary` }],
    covers_from: new Date(Date.UTC(2026, 10, day, 9)),
  });

  it('keeps the flat layout for a single part', () => {
    const r = buildCombinedSummary([part('One', 1)], 'Conv');
    expect(r.title).toBe('One');
    expect(r.sections.map((s) => s.heading)).toEqual(['Summary']);
  });

  it('adds dated session headers, oldest first, once resumed', () => {
    const r = buildCombinedSummary([part('One', 1), part('Two', 8)], null);
    expect(r.title).toBe('One — 2 sessions');
    expect(r.sections.map((s) => s.heading)).toEqual([
      'Session 1 · 1 Nov 2026 — One',
      'Summary',
      'Session 2 · 8 Nov 2026 — Two',
      'Summary',
    ]);
    expect(r.sections[2].content).toBe('Two topic');
  });
});
