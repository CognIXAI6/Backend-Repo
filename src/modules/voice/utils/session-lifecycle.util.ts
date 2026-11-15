import { ProviderDisruptionReason } from '../interfaces/voice-events.types';

/**
 * Coarse, redacted reasons a voice session stops, degrades or loses audio.
 * Ids and codes only — never transcript text, prompts, audio or an account
 * identifier — so they are safe to log and to ship to clients/telemetry.
 */

/** Why a session ended (terminal). */
export type SessionTerminalReason =
  | 'explicit_end' // client sent session:end
  | 'client_disconnect' // socket dropped without session:end
  | 'idle_timeout' // gateway 30-minute inactivity policy (no audio chunks)
  | 'provider_recovery_exhausted' // provider reconnect budget spent
  | 'server_restart'; // gateway shutting down for a restart

/** What took the provider connection down (starts a bounded recovery). */
export type ProviderDisruptionCause = 'provider_closed' | 'provider_error' | 'provider_transport_failure';

/** Why audio may be missing (non-terminal). */
export type AudioLossReason = 'sequence_gap' | 'recovery_buffer_bound';

export function providerDisruptionCause(reason: ProviderDisruptionReason): ProviderDisruptionCause {
  switch (reason) {
    case 'deepgram_closed':
      return 'provider_closed';
    case 'deepgram_error':
      return 'provider_error';
    default:
      return 'provider_transport_failure';
  }
}

/** Correlation ids shared with web/mobile. Opaque ids and counters only. */
export interface SessionCorrelation {
  /** Server-generated per session:start; the key for every lifecycle log/event of one session. */
  traceId: string | null;
  /** Server recording-session id (also stamped on persisted transcript segments). */
  recordingSessionId: string | null;
  /** The client's own generated session id, if it supplied one. */
  clientSessionId: string | null;
  /** Stream (recorder) currently active, and the provider connection epoch. */
  streamId: string | null;
  providerEpoch: number | null;
  /** Last audio sequence the server acknowledged on that stream (the ack boundary). */
  lastAckedSequence: number | null;
}
