import {
  buildSummaryReport,
  buildTranscriptItems,
  extractSessionContent,
  formatReportDate,
  formatReportRange,
  splitBullets,
  withSourceTranscripts,
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

  describe('multi-speaker attribution (production bug: every line was shown as the owner)', () => {
    const names = { owner: 'Temi', other: 'Other Speaker' };
    // exactly how a multi-speaker turn is persisted: labels in content, stripped words in transcript
    const multi = {
      role: 'user',
      speaker_label: 'multiple_speakers',
      content: '[Guest 1]: ready\n[Guest 7]: alright\n[Guest 1]: there you go alright',
      transcript: 'ready alright there you go alright',
    };

    it('reads the speakers from content, never the stripped transcript', () => {
      expect(buildTranscriptItems([multi] as any, names)).toEqual([
        { kind: 'turn', speaker: 'Guest 1', text: 'ready' },
        { kind: 'turn', speaker: 'Guest 7', text: 'alright' },
        { kind: 'turn', speaker: 'Guest 1', text: 'there you go alright' },
      ]);
    });

    it('prefers the per-speaker segments, which carry later guest renames', () => {
      const withSegments = {
        ...multi,
        segments: [
          { speaker_label: 'John', transcript: 'ready' },
          { speaker_label: 'Guest 7', transcript: 'alright' },
          { speaker_label: 'John', transcript: 'there you go alright' },
        ],
      };
      const items = buildTranscriptItems([withSegments] as any, names);
      expect(items.map((i: any) => i.speaker)).toEqual(['John', 'Guest 7', 'John']);
      expect(items.some((i: any) => i.speaker === 'Temi')).toBe(false);
    });

    it('maps role words in segments and never pins an unlabelled multi-speaker line on the owner', () => {
      const items = buildTranscriptItems(
        [
          { role: 'user', speaker_label: 'multiple_speakers', content: 'no label here', transcript: 'no label here' },
          { role: 'user', speaker_label: 'owner', content: 'mine', segments: [{ speaker_label: 'owner', transcript: 'mine' }] },
        ] as any,
        names,
      );
      expect(items).toEqual([
        { kind: 'turn', speaker: 'Unknown speaker', text: 'no label here' },
        { kind: 'turn', speaker: 'Temi', text: 'mine' },
      ]);
    });

    it('rebuilds every earlier session from its own time range (stored transcripts with the wrong names are replaced)', () => {
      const stale = { version: 1 as const, summary: 'S', transcript: [{ kind: 'turn' as const, speaker: 'Temi', text: 'wrong' }], keyInsights: [], actionPoints: [] };
      const parts = [
        { title: 'Mon', topic: null, sections: [], covers_from: '2026-11-18T09:00:00Z', covers_to: '2026-11-18T10:00:00Z', session_data: stale },
        { title: 'Tue', topic: null, sections: [], covers_from: '2026-11-19T09:00:00Z', covers_to: '2026-11-19T10:00:00Z', session_data: stale },
        { title: 'Empty', topic: null, sections: [], covers_from: '2026-11-20T09:00:00Z', covers_to: '2026-11-20T10:00:00Z', session_data: stale },
      ];
      const messages = [
        { ...multi, content: '[Guest 1]: monday words', created_at: '2026-11-18T09:30:00Z' },
        { ...multi, content: '[Guest 2]: tuesday words', created_at: '2026-11-19T09:30:00Z' },
      ];
      const report = buildSummaryReport(withSourceTranscripts(parts, messages as any, names), 'Conv');
      expect(report.sessions[0].transcript).toEqual([{ kind: 'turn', speaker: 'Guest 1', text: 'monday words' }]);
      expect(report.sessions[1].transcript).toEqual([{ kind: 'turn', speaker: 'Guest 2', text: 'tuesday words' }]);
      expect(report.sessions[2].transcript).toEqual(stale.transcript); // nothing left in range: stored copy kept
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
