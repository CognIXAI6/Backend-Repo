/** Wire payloads for the provider-recovery Socket.IO event contract. */

export type ProviderDisruptionReason = 'deepgram_error' | 'deepgram_closed' | 'transport_failure';

export interface SessionRecoveringPayload {
  recoveryId: string;
  reason: ProviderDisruptionReason;
  attempt: number;
  maxAttempts: number;
  recoverable: true;
}

export interface SessionRecoveredPayload {
  recoveryId: string;
  providerEpoch: number;
  audioGapDetected: boolean;
  droppedDurationMs: number;
}

export interface SessionDegradedProviderFailurePayload {
  recoveryId: string;
  reason: 'provider_recovery_exhausted';
  category: 'provider_recovery_failed';
  recoverable: false;
  incidentId: string;
  message: string;
}

export interface AudioContinuityWarningPayload {
  streamId: string;
  expected: number;
  actual: number;
  recoverable: boolean;
  message: string;
  /** Only populated when the gap came from the provider-recovery buffer overflowing. */
  droppedDurationMs?: number;
}
