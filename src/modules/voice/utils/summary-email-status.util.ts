/**
 * The summary email's coarse outcome. Never holds a recipient, provider response or
 * message content — only a status, a short reason code and a timestamp.
 *
 * `accepted_by_provider` ≠ delivered: the provider took the message; whether it reaches
 * an inbox is not something this server can know.
 */
export type SummaryEmailStatus = 'pending' | 'accepted_by_provider' | 'failed' | 'skipped';

export type SummaryEmailReason =
  | 'no_recipient' // the account has no email address on file
  | 'transport_not_configured' // no email provider configured on this deployment
  | 'attachment_failed' // the PDF attachment could not be built
  | 'provider_rejected' // the provider refused the message (4xx)
  | 'provider_unavailable' // rate limit, timeout, network or 5xx
  | 'unknown_error';

/** What the API reports; `unknown` is derived (legacy rows, abandoned attempts), never stored. */
export type SummaryEmailApiStatus = SummaryEmailStatus | 'unknown';

export interface SummaryEmailOutcome {
  status: SummaryEmailApiStatus;
  reason: SummaryEmailReason | 'stale_pending' | null;
  updatedAt: string | null;
  documentId: string | null;
}

/** A 'pending' attempt older than this was abandoned (crash/restart) — report unknown, not pending forever. */
export const SUMMARY_EMAIL_PENDING_STALE_MS = 10 * 60 * 1000;

const STORED_STATUSES: ReadonlySet<string> = new Set(['pending', 'accepted_by_provider', 'failed', 'skipped']);

/** Maps a thrown send/attachment error to a coarse reason. Reads codes only — never the message text. */
export function classifyEmailError(err: unknown): SummaryEmailReason {
  const e = err as { statusCode?: unknown; status?: unknown; code?: unknown; message?: unknown } | null;
  const status = Number(e?.statusCode ?? e?.status);
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = typeof e?.message === 'string' ? e.message : '';

  if (/no email transport configured/i.test(message)) return 'transport_not_configured';
  if (Number.isFinite(status)) {
    if (status === 429 || status >= 500) return 'provider_unavailable';
    if (status >= 400) return 'provider_rejected';
  }
  if (/^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ESOCKET|ECONNECTION)$/i.test(code)) return 'provider_unavailable';
  return 'unknown_error';
}

interface EmailStatusRow {
  summary_email_status?: string | null;
  summary_email_reason?: string | null;
  summary_email_updated_at?: Date | string | null;
  summary_email_document_id?: string | null;
}

/** API view of a conversation row. Legacy/absent/unrecognised → `unknown`. */
export function deriveSummaryEmail(row: EmailStatusRow | null | undefined, now: number = Date.now()): SummaryEmailOutcome {
  const unknown: SummaryEmailOutcome = { status: 'unknown', reason: null, updatedAt: null, documentId: null };
  const status = row?.summary_email_status;
  if (!status || !STORED_STATUSES.has(status)) return unknown;

  const updatedAt = row?.summary_email_updated_at ? new Date(row.summary_email_updated_at) : null;
  if (status === 'pending' && updatedAt && now - updatedAt.getTime() > SUMMARY_EMAIL_PENDING_STALE_MS) {
    return { status: 'unknown', reason: 'stale_pending', updatedAt: updatedAt.toISOString(), documentId: row?.summary_email_document_id ?? null };
  }
  return {
    status: status as SummaryEmailStatus,
    reason: (row?.summary_email_reason as SummaryEmailReason | null) ?? null,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    documentId: row?.summary_email_document_id ?? null,
  };
}
