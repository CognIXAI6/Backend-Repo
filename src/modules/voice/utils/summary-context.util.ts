/**
 * Complete-context planning for conversation summaries.
 *
 * The old path silently kept only the LAST 80 messages and then only the FIRST 12,000
 * characters of that — so a long conversation lost both its beginning and its end while
 * the whole range was still recorded as "covered". This planner never drops content:
 *
 *   single  – everything fits one model call;
 *   chunked – consecutive, ordered chunks (map), each condensed to notes, then ONE final
 *             summary is written from all the notes in order (reduce) → beginning, middle
 *             and end are all represented;
 *   too_large – past the hard bound: NO summary is produced and the caller must report a
 *             truthful failure, rather than summarising a fragment and claiming it all.
 *
 * Compaction here is derived context only: the stored messages are never modified.
 * Nothing in this file logs or retains text beyond the returned plan.
 */

export const SUMMARY_CONTEXT_BOUNDS = {
  /** Up to this many characters the whole conversation goes to the model in one call. */
  SINGLE_PASS_CHARS: 24_000,
  /** Size of each ordered chunk when the conversation is longer. */
  CHUNK_CHARS: 12_000,
  /** At most this many chunks → hard bound on total input (MAX_CHUNKS × CHUNK_CHARS). */
  MAX_CHUNKS: 24,
  /** Longest condensed-notes text kept per chunk (≈350 words). */
  NOTES_MAX_CHARS: 2_400,
  /** Each model step (a chunk's notes, or the final write-up) must finish within this. */
  STEP_TIMEOUT_MS: 90_000,
  /** The whole summary (all steps) must finish within this. */
  TOTAL_TIMEOUT_MS: 6 * 60_000,
} as const;

export const SUMMARY_CONTEXT_MAX_TOTAL_CHARS = SUMMARY_CONTEXT_BOUNDS.CHUNK_CHARS * SUMMARY_CONTEXT_BOUNDS.MAX_CHUNKS;

export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ContextTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ContextCoverage {
  /** Non-blank messages considered. */
  messageCount: number;
  /** Total characters of those messages' content. */
  charCount: number;
  /** Number of model "chunks" (0 for a single pass). */
  chunkCount: number;
}

export interface ContextChunk {
  /** 1-based, in conversation order. */
  index: number;
  turns: ContextTurn[];
  /** Inclusive range of (non-blank) message positions this chunk spans. */
  firstMessage: number;
  lastMessage: number;
  chars: number;
}

export type ContextPlan =
  | { kind: 'empty'; coverage: ContextCoverage }
  | { kind: 'single'; turns: ContextTurn[]; coverage: ContextCoverage }
  | { kind: 'chunked'; chunks: ContextChunk[]; coverage: ContextCoverage }
  | { kind: 'too_large'; maxChars: number; coverage: ContextCoverage };

/** The rendered length of one turn as the model will see it ("User: …\n"). */
const turnChars = (t: ContextTurn) => (t.role === 'user' ? 6 : 4) + t.content.length + 1;

/**
 * Splits one over-long message into ordered pieces no longer than `max`, preferring
 * paragraph, then sentence, then word boundaries. Concatenating the pieces (with the
 * single separator characters they were split on) reproduces the original.
 */
export function splitLongText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    // never cut so early that progress is tiny; fall back to a hard cut
    const at = cut > max * 0.5 ? cut + 1 : max;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

export function planSummaryContext(messages: ContextMessage[]): ContextPlan {
  const turns: ContextTurn[] = messages
    .filter((m) => (m.content ?? '').trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));

  const charCount = turns.reduce((n, t) => n + t.content.length, 0);
  const baseCoverage = { messageCount: turns.length, charCount, chunkCount: 0 };
  if (turns.length === 0) return { kind: 'empty', coverage: baseCoverage };

  const rendered = turns.reduce((n, t) => n + turnChars(t), 0);
  if (rendered <= SUMMARY_CONTEXT_BOUNDS.SINGLE_PASS_CHARS) return { kind: 'single', turns, coverage: baseCoverage };
  if (rendered > SUMMARY_CONTEXT_MAX_TOTAL_CHARS) {
    return { kind: 'too_large', maxChars: SUMMARY_CONTEXT_MAX_TOTAL_CHARS, coverage: baseCoverage };
  }

  const max = SUMMARY_CONTEXT_BOUNDS.CHUNK_CHARS;
  const chunks: ContextChunk[] = [];
  let current: ContextChunk | null = null;

  const push = (turn: ContextTurn, messageIndex: number) => {
    const size = turnChars(turn);
    if (!current || current.chars + size > max) {
      current = { index: chunks.length + 1, turns: [], firstMessage: messageIndex, lastMessage: messageIndex, chars: 0 };
      chunks.push(current);
    }
    current.turns.push(turn);
    current.lastMessage = messageIndex;
    current.chars += size;
  };

  turns.forEach((turn, i) => {
    const pieces = turnChars(turn) > max ? splitLongText(turn.content, max - 8) : [turn.content];
    pieces.forEach((piece) => push({ role: turn.role, content: piece }, i + 1));
  });

  // Splitting/packing can add a handful of chunks beyond the estimate; the bound is on chunks.
  if (chunks.length > SUMMARY_CONTEXT_BOUNDS.MAX_CHUNKS) {
    return { kind: 'too_large', maxChars: SUMMARY_CONTEXT_MAX_TOTAL_CHARS, coverage: baseCoverage };
  }
  return { kind: 'chunked', chunks, coverage: { ...baseCoverage, chunkCount: chunks.length } };
}

export type DeadlineResult<T> = { timedOut: false; value: T } | { timedOut: true };

/** Resolves with the value, or { timedOut: true } if it has not settled within `ms`. Rejections propagate. */
export async function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
