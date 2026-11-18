/**
 * Structured model of a conversation-summary report. Both renderers (Word and PDF) draw from
 * this one shape, so the two documents have the same content and layout:
 *
 *   cover (topic, date range, session count)
 *   → "Sessions at a glance" table
 *   → one section per conversation/session, each page-separated:
 *        summary → transcript (speaker by speaker, with the AI's insights) → key insights → action points
 */

/** One entry in a session's word-for-word transcript. */
export type TranscriptItem =
  | { kind: 'turn'; speaker: string; text: string }
  /** The AI's "insights & suggestions" shown after the turns that prompted them. */
  | { kind: 'insights'; bullets: string[] };

export interface ReportSession {
  /** 1-based, oldest first. */
  number: number;
  /** ISO timestamp of the session's first message (rendered as a UTC calendar date). */
  date: string;
  title: string;
  /** One-line description shown under the session title. */
  description: string;
  summary: string;
  transcript: TranscriptItem[];
  keyInsights: string[];
  actionPoints: string[];
}

export interface SummaryReport {
  /** Cover title: the conversation's topic. */
  title: string;
  sessions: ReportSession[];
  /** ISO timestamp the report was generated. */
  generatedAt: string;
}

/** The structured content stored with each summary part (conversation_summary_parts.session_data). */
export interface StoredSessionData {
  version: 1;
  summary: string;
  transcript: TranscriptItem[];
  keyInsights: string[];
  actionPoints: string[];
}
