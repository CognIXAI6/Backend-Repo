import { SUMMARY_EMAIL_PENDING_STALE_MS, classifyEmailError, deriveSummaryEmail } from './summary-email-status.util';

describe('classifyEmailError', () => {
  it.each([
    [{ statusCode: 400 }, 'provider_rejected'],
    [{ statusCode: 422 }, 'provider_rejected'],
    [{ statusCode: 401 }, 'provider_rejected'],
    [{ statusCode: 429 }, 'provider_unavailable'],
    [{ statusCode: 500 }, 'provider_unavailable'],
    [{ status: 503 }, 'provider_unavailable'],
    [{ code: 'ECONNRESET' }, 'provider_unavailable'],
    [{ code: 'ENOTFOUND' }, 'provider_unavailable'],
    [{ message: 'No email transport configured' }, 'transport_not_configured'],
    [{ message: 'something else' }, 'unknown_error'],
    [null, 'unknown_error'],
    ['string error', 'unknown_error'],
  ])('%j → %s', (err, reason) => {
    expect(classifyEmailError(err)).toBe(reason);
  });

  it('reads codes, never the message text: a message that merely mentions a status does not decide', () => {
    expect(classifyEmailError(new Error('upstream said 503 for jane@example.com'))).toBe('unknown_error');
  });
});

describe('deriveSummaryEmail', () => {
  const now = Date.UTC(2026, 10, 17, 12, 0, 0);

  it('legacy rows (no status) and unrecognised values are unknown', () => {
    const unknown = { status: 'unknown', reason: null, updatedAt: null, documentId: null };
    expect(deriveSummaryEmail({}, now)).toEqual(unknown);
    expect(deriveSummaryEmail(null, now)).toEqual(unknown);
    expect(deriveSummaryEmail({ summary_email_status: 'delivered' }, now)).toEqual(unknown); // not a status this server ever writes
  });

  it('reports a stored outcome with ISO timestamp and document id', () => {
    expect(deriveSummaryEmail({
      summary_email_status: 'accepted_by_provider', summary_email_reason: null,
      summary_email_updated_at: new Date(now - 1_000), summary_email_document_id: 'doc-1',
    }, now)).toEqual({ status: 'accepted_by_provider', reason: null, updatedAt: new Date(now - 1_000).toISOString(), documentId: 'doc-1' });
    expect(deriveSummaryEmail({ summary_email_status: 'failed', summary_email_reason: 'provider_rejected', summary_email_updated_at: new Date(now) }, now))
      .toMatchObject({ status: 'failed', reason: 'provider_rejected' });
  });

  it('a recent pending attempt is pending; an abandoned one is unknown, not pending forever', () => {
    const fresh = deriveSummaryEmail({ summary_email_status: 'pending', summary_email_updated_at: new Date(now - 60_000) }, now);
    expect(fresh.status).toBe('pending');
    const stale = deriveSummaryEmail({ summary_email_status: 'pending', summary_email_updated_at: new Date(now - SUMMARY_EMAIL_PENDING_STALE_MS - 1) }, now);
    expect(stale).toMatchObject({ status: 'unknown', reason: 'stale_pending' });
  });
});
