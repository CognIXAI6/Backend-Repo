import {
  buildSummaryReport,
  buildTranscriptItems,
  extractSessionContent,
  formatReportDate,
  formatReportRange,
  splitBullets,
} from './summary-report.util';

describe('summary-report.util', () => {
  describe('buildTranscriptItems', () => {
    const names = { owner: 'Mr Tolu', other: 'Dr Amaka' };

    it('attributes each turn to its real speaker and AI replies become insight blocks', () => {
      const items = buildTranscriptItems(
        [
          { role: 'user', speaker_label: 'owner', content: 'hello', transcript: 'hello' },
          { role: 'user', speaker_label: 'other', content: 'hi back', transcript: 'hi back' },
          { role: 'assistant', content: '- Nothing to flag.\n- Ask about the budget.' },
        ] as any,
        names,
      );
      expect(items).toEqual([
        { kind: 'turn', speaker: 'Mr Tolu', text: 'hello' },
        { kind: 'turn', speaker: 'Dr Amaka', text: 'hi back' },
        { kind: 'insights', bullets: ['Nothing to flag.', 'Ask about the budget.'] },
      ]);
    });

    it('splits bracketed multi-speaker lines into separate named turns', () => {
      const text = '[Dr Smith]: first point\n[Dr Jones]: second point';
      const items = buildTranscriptItems([{ role: 'user', speaker_label: 'multiple_speakers', content: text, transcript: text }] as any, names);
      expect(items).toEqual([
        { kind: 'turn', speaker: 'Dr Smith', text: 'first point' },
        { kind: 'turn', speaker: 'Dr Jones', text: 'second point' },
      ]);
    });

    it('merges consecutive turns by the same speaker and drops blank assistant messages', () => {
      const items = buildTranscriptItems(
        [
          { role: 'user', speaker_label: 'owner', content: 'one', transcript: 'one' },
          { role: 'user', speaker_label: 'owner', content: 'two', transcript: 'two' },
          { role: 'assistant', content: '   ' },
        ] as any,
        names,
      );
      expect(items).toEqual([{ kind: 'turn', speaker: 'Mr Tolu', text: 'one two' }]);
    });
  });

  describe('extractSessionContent / splitBullets', () => {
    it('pulls summary, key insights and follow-up actions out of the model sections', () => {
      const c = extractSessionContent([
        { heading: 'Summary', content: 'They synced.' },
        { heading: 'Key Insights', content: '- A\n- B' },
        { heading: 'Follow-up Actions', content: '1. Do it' },
      ]);
      expect(c.summary).toBe('They synced.');
      expect(c.keyInsights).toEqual(['A', 'B']);
      expect(c.actionPoints).toEqual(['Do it']);
    });

    it('splitBullets handles empty input', () => {
      expect(splitBullets(null)).toEqual([]);
      expect(splitBullets('')).toEqual([]);
    });
  });

  describe('buildSummaryReport', () => {
    const stored = (summary: string) => ({ version: 1 as const, summary, transcript: [{ kind: 'turn' as const, speaker: 'A', text: 'x' }], keyInsights: ['k'], actionPoints: ['a'] });

    it('is one session per part, oldest first, numbered from 1, with a UTC date each', () => {
      const report = buildSummaryReport(
        [
          { title: 'Yesterday', topic: 'T1', sections: [], covers_from: new Date(Date.UTC(2026, 10, 17, 9)), session_data: stored('S1') },
          { title: 'Today', topic: 'T2', sections: [], covers_from: new Date(Date.UTC(2026, 10, 18, 9)), session_data: stored('S2') },
        ],
        'My Conversation',
        new Date(Date.UTC(2026, 10, 18, 12)),
      );
      expect(report.title).toBe('My Conversation');
      expect(report.sessions.map((s) => [s.number, s.title, s.summary, s.date.slice(0, 10)])).toEqual([
        [1, 'Yesterday', 'S1', '2026-11-17'],
        [2, 'Today', 'S2', '2026-11-18'],
      ]);
    });

    it('renders parts stored before structured data existed from their sections', () => {
      const report = buildSummaryReport(
        [
          {
            title: 'Old',
            topic: null,
            covers_from: '2026-11-03T09:00:00Z',
            sections: [
              { heading: 'Summary', content: 'Reviewed Q3.' },
              { heading: 'Transcript', content: 'Mr Tolu: hello\nCognIX AI: fine' },
              { heading: 'Action Points / Next Steps', content: '- Send deck' },
            ],
          },
        ],
        null,
      );
      const s = report.sessions[0];
      expect(report.title).toBe('Old');
      expect(s.summary).toBe('Reviewed Q3.');
      expect(s.actionPoints).toEqual(['Send deck']);
      expect(JSON.stringify(s.transcript)).toContain('hello');
    });
  });

  describe('date formatting', () => {
    it('formats a single date and a range in the sample style', () => {
      expect(formatReportDate('2026-11-13T09:00:00Z')).toBe('13 NOV 2026');
      expect(formatReportRange(['2026-11-13T09:00:00Z', '2026-11-13T18:00:00Z'])).toBe('13 NOV 2026');
      expect(formatReportRange(['2026-11-13T09:00:00Z', '2026-11-16T09:00:00Z'])).toContain('13');
      expect(formatReportRange(['2026-11-13T09:00:00Z', '2026-11-16T09:00:00Z'])).toContain('16');
    });
  });
});
