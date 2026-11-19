import type {
  ReportSession,
  StoredSessionData,
  SummaryReport,
  TranscriptItem,
} from '@/modules/documents/summary-report/summary-report.types';

/** Strips a leading list marker ("- ", "• ", "* ", "1. ") from one line. */
const stripMarker = (line: string) => line.replace(/^\s*(?:[-•*–]|\d{1,2}[.)])\s+/, '').trim();

/** Splits model/assistant text into clean bullet strings (one per list item, or per non-empty line). */
export function splitBullets(text: string | null | undefined): string[] {
  return String(text ?? '')
    .split('\n')
    .map(stripMarker)
    .filter(Boolean);
}

interface MessageLike {
  role: string;
  content?: string | null;
  transcript?: string | null;
  speaker_label?: string | null;
  /** Per-speaker segments of this message (multi-speaker recordings) — the most accurate attribution. */
  segments?: Array<{ speaker_label: string; transcript: string }> | null;
}

/**
 * Turns persisted messages into the transcript: each speaker's words in order, and the AI's replies as
 * "insights & suggestions" blocks. Same speaker resolution as the old verbatim transcript, but structured.
 * Consecutive lines by the same speaker (no AI reply between them) are merged into one turn.
 */
export function buildTranscriptItems(
  messages: MessageLike[],
  names: { owner: string; other: string },
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const pushTurn = (speaker: string, text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const last = items[items.length - 1];
    if (last && last.kind === 'turn' && last.speaker === speaker) last.text = `${last.text} ${clean}`;
    else items.push({ kind: 'turn', speaker, text: clean });
  };

  for (const m of messages) {
    if (m.role === 'assistant') {
      const bullets = splitBullets(m.content);
      if (bullets.length > 0) items.push({ kind: 'insights', bullets });
      continue;
    }

    // Multi-speaker turns: the segments say who said what (and carry later guest renames).
    if (m.segments && m.segments.length > 0) {
      for (const seg of m.segments) pushTurn(resolveLabel(seg.speaker_label, names), seg.transcript ?? '');
      continue;
    }

    if (m.speaker_label === 'multiple_speakers') {
      // No segments: `content` is "[Name]: text" per line. Never `transcript` — that is the
      // raw words with the speaker labels stripped, which put every line on the owner.
      const text = (m.content ?? m.transcript ?? '').trim();
      for (const rawLine of text.split('\n')) {
        const match = rawLine.match(/^\[(.+?)\]:\s*(.*)$/);
        if (match) pushTurn(resolveLabel(match[1], names), match[2]);
        else pushTurn('Unknown speaker', rawLine);
      }
      continue;
    }

    const text = (m.transcript ?? m.content ?? '').trim();
    if (!text) continue;

    const speaker =
      m.speaker_label === 'owner' ? names.owner
        : m.speaker_label === 'other' ? names.other
          : m.speaker_label === 'unknown' ? 'Unknown speaker'
            : names.owner; // single-speaker / text mode — the one human in the conversation
    pushTurn(speaker, text);
  }
  return items;
}

/** Segment / bracket labels are display names, except the two role words owner/other. */
function resolveLabel(label: string | null | undefined, names: { owner: string; other: string }): string {
  const l = (label ?? '').trim();
  if (!l || l === 'unknown') return 'Unknown speaker';
  if (l === 'owner') return names.owner;
  if (l === 'other') return names.other;
  return l;
}

const ACTION_HEADING = /follow-?up actions?|action points?|next steps?/i;
const INSIGHT_HEADING = /key insights?/i;

/** Picks the summary paragraph, key insights and action points out of the model's sections. */
export function extractSessionContent(sections: Array<{ heading: string; content: string }>) {
  let summary = '';
  let keyInsights: string[] = [];
  let actionPoints: string[] = [];
  for (const s of sections) {
    if (/^transcript$/i.test(s.heading.trim())) continue;
    if (ACTION_HEADING.test(s.heading)) actionPoints = splitBullets(s.content);
    else if (INSIGHT_HEADING.test(s.heading)) keyInsights = splitBullets(s.content);
    else if (!summary && /summary/i.test(s.heading)) summary = s.content.trim();
  }
  if (!summary) {
    // No section called "Summary": use the first one that is not a list we already took.
    summary = (sections.find((s) => !ACTION_HEADING.test(s.heading) && !INSIGHT_HEADING.test(s.heading) && !/^transcript$/i.test(s.heading.trim()))?.content ?? '').trim();
  }
  return { summary, keyInsights, actionPoints };
}

export function buildStoredSessionData(
  sections: Array<{ heading: string; content: string }>,
  transcript: TranscriptItem[],
): StoredSessionData {
  return { version: 1, ...extractSessionContent(sections), transcript };
}

/** Best-effort transcript from a LEGACY part whose transcript was stored as "Name: text" lines in a section. */
function parseLegacyTranscript(content: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([^:\n]{1,40}):\s*(.*)$/);
    if (!match) {
      const last = items[items.length - 1];
      if (last?.kind === 'turn') last.text = `${last.text} ${line}`;
      continue;
    }
    if (/^cognix ai$/i.test(match[1].trim())) {
      const bullets = splitBullets(match[2]);
      if (bullets.length) items.push({ kind: 'insights', bullets });
    } else {
      items.push({ kind: 'turn', speaker: match[1].trim(), text: match[2].trim() });
    }
  }
  return items;
}

export interface PartLike {
  title: string;
  topic: string | null;
  sections: Array<{ heading: string; content: string }>;
  covers_from: Date | string;
  covers_to?: Date | string | null;
  session_data?: StoredSessionData | null;
  /** Transcript rebuilt from the stored messages at render time — wins over the stored copy. */
  transcript_override?: TranscriptItem[] | null;
}

/**
 * Rebuilds each part's transcript from the conversation's messages in that part's own time range
 * (covers_from..covers_to), so attribution fixes and guest renames reach every session — not only
 * the newest. A part whose range has no messages left keeps its stored transcript.
 */
export function withSourceTranscripts<P extends PartLike>(
  parts: P[],
  messages: Array<MessageLike & { created_at: Date | string }>,
  names: { owner: string; other: string },
): P[] {
  return parts.map((part) => {
    if (part.transcript_override) return part;
    const from = new Date(part.covers_from).getTime();
    const to = part.covers_to ? new Date(part.covers_to).getTime() : Number.POSITIVE_INFINITY;
    const inRange = messages.filter((m) => {
      const t = new Date(m.created_at).getTime();
      return t >= from && t <= to;
    });
    const items = buildTranscriptItems(inRange, names);
    return items.length > 0 ? { ...part, transcript_override: items } : part;
  });
}

/**
 * One report session per stored part, oldest first. Parts written before structured data existed are
 * rendered from their sections (summary / insights / actions / "Name: text" transcript lines).
 */
export function buildSummaryReport(parts: PartLike[], conversationTitle: string | null, generatedAt: Date = new Date()): SummaryReport {
  const sessions: ReportSession[] = parts.map((part, i) => {
    const data = part.session_data && part.session_data.version === 1 ? part.session_data : null;
    const legacy = data ? null : extractSessionContent(part.sections);
    const legacyTranscript = data ? null : part.sections.find((s) => /^transcript$/i.test(s.heading.trim()));
    return {
      number: i + 1,
      date: new Date(part.covers_from).toISOString(),
      title: part.title,
      description: (part.topic ?? '').trim(),
      summary: data ? data.summary : legacy!.summary,
      transcript: part.transcript_override ?? (data ? data.transcript : parseLegacyTranscript(legacyTranscript?.content ?? '')),
      keyInsights: data ? data.keyInsights : legacy!.keyInsights,
      actionPoints: data ? data.actionPoints : legacy!.actionPoints,
    };
  });
  return {
    title: conversationTitle?.trim() || parts[0]?.title || 'Conversation summary',
    sessions,
    generatedAt: generatedAt.toISOString(),
  };
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "13 NOV 2026" (UTC calendar date). */
export function formatReportDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "13 – 17 NOV 2026", "28 OCT – 3 NOV 2026", "27 DEC 2026 – 3 JAN 2027", or a single date. */
export function formatReportRange(isoDates: string[]): string {
  if (isoDates.length === 0) return '';
  const ds = isoDates.map((s) => new Date(s)).sort((a, b) => a.getTime() - b.getTime());
  const a = ds[0];
  const b = ds[ds.length - 1];
  const sameDay = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  if (sameDay) return formatReportDate(a.toISOString());
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${formatReportDate(a.toISOString())} – ${formatReportDate(b.toISOString())}`;
  if (a.getUTCMonth() !== b.getUTCMonth()) return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  return `${a.getUTCDate()} – ${b.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
}

/** "November 17, 2026" for the "Generated by CognIX AI" line. */
export function formatGeneratedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
