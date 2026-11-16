import {
  SUMMARY_CONTEXT_BOUNDS,
  SUMMARY_CONTEXT_MAX_TOTAL_CHARS,
  planSummaryContext,
  raceDeadline,
  splitLongText,
} from './summary-context.util';

const msg = (i: number, len = 200, role: 'user' | 'assistant' = i % 2 ? 'assistant' : 'user') => ({
  role, content: `m${i}:`.padEnd(len, 'x'),
});
const many = (n: number, len = 200) => Array.from({ length: n }, (_, i) => msg(i + 1, len));

describe('planSummaryContext', () => {
  it('ignores blank messages and reports an empty plan', () => {
    expect(planSummaryContext([{ role: 'user', content: '   ' }, { role: 'assistant', content: '' }]).kind).toBe('empty');
    expect(planSummaryContext([]).coverage).toEqual({ messageCount: 0, charCount: 0, chunkCount: 0 });
  });

  it('keeps a conversation beyond the OLD limits in one call when it still fits: 200 messages (> 80) and 30k chars-ish are not cut', () => {
    const messages = many(200, 100); // 200 messages, 20k chars: old path kept 80 messages and 12k chars
    const plan = planSummaryContext(messages);
    expect(plan.kind).toBe('single');
    if (plan.kind !== 'single') return;
    expect(plan.turns).toHaveLength(200);
    expect(plan.turns[0].content).toBe(messages[0].content); // the beginning is still there
    expect(plan.turns.at(-1)!.content).toBe(messages[199].content); // and the end
  });

  it('chunks a long conversation in order: beginning, middle and end are all in a chunk, nothing is lost or reordered', () => {
    const messages = many(300, 200); // 60k chars, 300 messages
    const plan = planSummaryContext(messages);
    expect(plan.kind).toBe('chunked');
    if (plan.kind !== 'chunked') return;

    expect(plan.chunks.every((c) => c.chars <= SUMMARY_CONTEXT_BOUNDS.CHUNK_CHARS)).toBe(true);
    expect(plan.chunks.length).toBeLessThanOrEqual(SUMMARY_CONTEXT_BOUNDS.MAX_CHUNKS);
    expect(plan.coverage).toEqual({ messageCount: 300, charCount: 60_000, chunkCount: plan.chunks.length });

    // contiguous, ordered, covering message 1 … 300
    expect(plan.chunks[0].firstMessage).toBe(1);
    expect(plan.chunks.at(-1)!.lastMessage).toBe(300);
    plan.chunks.forEach((c, i) => {
      expect(c.index).toBe(i + 1);
      if (i > 0) expect(c.firstMessage).toBeGreaterThanOrEqual(plan.chunks[i - 1].lastMessage);
    });

    // every message appears exactly once, in order
    const flat = plan.chunks.flatMap((c) => c.turns.map((t) => t.content));
    expect(flat).toEqual(messages.map((m) => m.content));

    // beginning / middle / end land in the first / a middle / the last chunk
    const where = (needle: string) => plan.chunks.findIndex((c) => c.turns.some((t) => t.content.startsWith(needle)));
    expect(where('m1:')).toBe(0);
    expect(where('m150:')).toBeGreaterThan(0);
    expect(where('m150:')).toBeLessThan(plan.chunks.length - 1);
    expect(where('m300:')).toBe(plan.chunks.length - 1);
  });

  it('splits a single message larger than a chunk without losing a character', () => {
    const long = Array.from({ length: 3_000 }, (_, i) => `Sentence number ${i}.`).join(' '); // ~60k chars
    const plan = planSummaryContext([{ role: 'user', content: 'opening remark' }, { role: 'assistant', content: long }, { role: 'user', content: 'closing remark' }]);
    expect(plan.kind).toBe('chunked');
    if (plan.kind !== 'chunked') return;
    const assistantPieces = plan.chunks.flatMap((c) => c.turns).filter((t) => t.role === 'assistant').map((t) => t.content);
    expect(assistantPieces.length).toBeGreaterThan(1);
    expect(assistantPieces.join('')).toBe(long);
    expect(plan.chunks.every((c) => c.chars <= SUMMARY_CONTEXT_BOUNDS.CHUNK_CHARS)).toBe(true);
    expect(plan.chunks[0].turns[0].content).toBe('opening remark');
    expect(plan.chunks.at(-1)!.turns.at(-1)!.content).toBe('closing remark');
  });

  it('at the edge of the hard bound it still chunks within MAX_CHUNKS', () => {
    const plan = planSummaryContext(many(1_300, 200)); // ~260k chars (< 288k)
    expect(plan.kind).toBe('chunked');
    if (plan.kind === 'chunked') expect(plan.chunks.length).toBeLessThanOrEqual(SUMMARY_CONTEXT_BOUNDS.MAX_CHUNKS);
  });

  it('beyond the hard bound it refuses (too_large) and reports truthful totals — it does not summarise a fragment', () => {
    const messages = many(2_000, 200); // 400k chars
    const plan = planSummaryContext(messages);
    expect(plan).toEqual({
      kind: 'too_large',
      maxChars: SUMMARY_CONTEXT_MAX_TOTAL_CHARS,
      coverage: { messageCount: 2_000, charCount: 400_000, chunkCount: 0 },
    });
    expect(SUMMARY_CONTEXT_MAX_TOTAL_CHARS).toBe(SUMMARY_CONTEXT_BOUNDS.CHUNK_CHARS * SUMMARY_CONTEXT_BOUNDS.MAX_CHUNKS);
  });
});

describe('splitLongText', () => {
  it('returns short text untouched and splits long text on boundaries, reassembling exactly', () => {
    expect(splitLongText('short', 100)).toEqual(['short']);
    const text = 'alpha beta gamma. '.repeat(500);
    const pieces = splitLongText(text, 1_000);
    expect(pieces.every((p) => p.length <= 1_000)).toBe(true);
    expect(pieces.join('')).toBe(text);
  });
  it('hard-cuts text with no boundaries at all', () => {
    const text = 'x'.repeat(5_000);
    const pieces = splitLongText(text, 1_000);
    expect(pieces).toHaveLength(5);
    expect(pieces.join('')).toBe(text);
  });
});

describe('raceDeadline', () => {
  afterEach(() => jest.useRealTimers());

  it('returns the value when the work finishes in time', async () => {
    await expect(raceDeadline(Promise.resolve(42), 1_000)).resolves.toEqual({ timedOut: false, value: 42 });
  });
  it('reports a timeout when it does not', async () => {
    jest.useFakeTimers();
    const racing = raceDeadline(new Promise<number>(() => undefined), 5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(racing).resolves.toEqual({ timedOut: true });
  });
  it('propagates a rejection', async () => {
    await expect(raceDeadline(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
  });
});
