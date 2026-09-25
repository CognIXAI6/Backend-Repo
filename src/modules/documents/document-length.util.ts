import type { DocumentSection } from './document.service';

export type DocumentFormat = 'docx' | 'pdf';

// Words that fit on the first page (which also holds the title block) and on each
// following page, with headings and paragraph spacing included.
//  - pdf: measured by rendering (Helvetica 11pt, 72pt margins).
//  - docx: estimated from Calibri 11pt metrics with 1" margins (no Word renderer
//    was available to measure) — Calibri is narrower than Helvetica, so a page
//    holds ~25% more. Re-tune here if real Word page counts drift.
export const PAGE_CAPACITY: Record<DocumentFormat, { first: number; next: number }> = {
  pdf: { first: 350, next: 475 },
  docx: { first: 450, next: 575 },
};

// Accepted range around the requested length before the model is asked to redo it.
export const MIN_LENGTH_RATIO = 0.9;
export const MAX_LENGTH_RATIO = 1.2;

export function countWords(sections: DocumentSection[]): number {
  return sections.reduce(
    (total, s) => total + `${s.heading} ${s.content}`.split(/\s+/).filter(Boolean).length,
    0,
  );
}

/** Words needed to fill `pages` pages. */
export function targetWords(pages: number, format: DocumentFormat = 'docx'): number {
  const { first, next } = PAGE_CAPACITY[format];
  return first + (pages - 1) * next;
}

export function estimatePages(words: number, format: DocumentFormat = 'docx'): number {
  const { first, next } = PAGE_CAPACITY[format];
  const pages = words <= first ? 1 : 1 + (words - first) / next;
  return Math.max(1, Math.round(pages * 10) / 10);
}

export type LengthCheck =
  | { ok: true; words: number; estimatedPages: number }
  | { ok: false; words: number; estimatedPages: number; message: string };

/** Compares a drafted document against the page count the user asked for. */
export function checkLength(
  sections: DocumentSection[],
  pages: number,
  format: DocumentFormat = 'docx',
): LengthCheck {
  const words = countWords(sections);
  const estimatedPages = estimatePages(words, format);
  const target = targetWords(pages, format);
  const ask =
    `the user asked for ${pages} page(s) (~${target} words as ${format}) but this draft is ` +
    `~${words} words (≈${estimatedPages} pages)`;

  if (words < target * MIN_LENGTH_RATIO) {
    return {
      ok: false,
      words,
      estimatedPages,
      message:
        `Document NOT generated: ${ask}. Call generate_document again with the same title, topic and ` +
        `pages, expanding the sections to about ${target} words in total — add depth, examples and detail ` +
        `rather than padding. Do not mention this retry to the user.`,
    };
  }

  if (words > target * MAX_LENGTH_RATIO) {
    return {
      ok: false,
      words,
      estimatedPages,
      message:
        `Document NOT generated: ${ask}. Call generate_document again with the same title, topic and ` +
        `pages, tightened to about ${target} words in total. Do not mention this retry to the user.`,
    };
  }

  return { ok: true, words, estimatedPages };
}
