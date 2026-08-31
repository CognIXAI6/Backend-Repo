/**
 * Lifecycle of the Deepgram provider connection underlying an active voice
 * session. Distinct from the outer application/Socket.IO session, which
 * survives a provider reconnect.
 */
export type ProviderSessionState =
  | 'active'
  | 'recovering'
  | 'recovered'
  | 'failed'
  | 'intentionally_closed';

/** Diagnostics captured at the moment the provider WebSocket closes. */
export interface ProviderCloseInfo {
  code: number | null;
  reason: string | null;
  wasClean: boolean | null;
  /** readyState of the underlying socket at the moment 'close' fired. */
  readyStateAtClose: number;
  /** Whether an 'error' (frame or transport-level) preceded this close. */
  errorPreceded: boolean;
  lastAudioAt: number | null;
  lastKeepAliveAt: number | null;
  closedAt: number;
}
