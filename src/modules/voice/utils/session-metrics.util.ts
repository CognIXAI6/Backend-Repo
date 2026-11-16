/**
 * Per-session memory/queue bounds and observability. Counts and byte sizes
 * only — never transcript text, prompts, audio or any user identifier.
 *
 * Bound policy: in-memory *context* (history windows) is trimmed because the
 * authoritative transcript is persisted; anything NOT yet persisted (pending
 * turns/text) is never dropped — reaching its bound forces a flush instead.
 */
export const SESSION_BOUNDS = {
  /** In-memory multi-speaker turn history (AI context reads the last 60; DB holds all). */
  MAX_MULTI_HISTORY_TURNS: 400,
  /** In-memory dual-speaker turn history (AI context reads the last 40). */
  MAX_DUAL_HISTORY_TURNS: 200,
  /** Rolling window of STT confidence samples (only an average is used). */
  MAX_CONFIDENCE_SAMPLES: 500,
  /** Un-persisted multi-speaker turns waiting for a flush before one is forced. */
  MAX_PENDING_TURNS: 150,
  /** Un-persisted pending text (chars, multi or dual) before a flush is forced. */
  MAX_PENDING_CHARS: 30_000,
  /** Minimum gap between metric samples taken from the audio path. */
  SAMPLE_INTERVAL_MS: 5_000,
} as const;

export type BoundKind =
  | 'multiHistoryTrim'
  | 'dualHistoryTrim'
  | 'confidenceTrim'
  | 'pendingForceFlush'
  | 'audioBufferCap'
  | 'speakerAudioCap'
  | 'recoveryBufferByteOverflow'
  | 'recoveryBufferAgeEvict';

export interface SessionMetrics {
  samples: number;
  lastSampledAt: number;
  highWater: {
    multiHistoryTurns: number;
    dualHistoryTurns: number;
    confidenceSamples: number;
    pendingTurns: number;
    pendingChars: number;
    audioBufferBytes: number;
    speakerAudioBytes: number;
    recoveryBufferBytes: number;
    recoveryBufferChunks: number;
    inFlightTurns: number;
  };
  boundHits: Record<BoundKind, number>;
  /** Turns removed from the in-memory history windows (still persisted in the database). */
  trimmedHistoryTurns: number;
  /** Bound kinds already logged once (log only the first hit of each kind). */
  loggedKinds: Set<BoundKind>;
}

export function createSessionMetrics(): SessionMetrics {
  return {
    samples: 0,
    lastSampledAt: 0,
    highWater: {
      multiHistoryTurns: 0,
      dualHistoryTurns: 0,
      confidenceSamples: 0,
      pendingTurns: 0,
      pendingChars: 0,
      audioBufferBytes: 0,
      speakerAudioBytes: 0,
      recoveryBufferBytes: 0,
      recoveryBufferChunks: 0,
      inFlightTurns: 0,
    },
    boundHits: {
      multiHistoryTrim: 0,
      dualHistoryTrim: 0,
      confidenceTrim: 0,
      pendingForceFlush: 0,
      audioBufferCap: 0,
      speakerAudioCap: 0,
      recoveryBufferByteOverflow: 0,
      recoveryBufferAgeEvict: 0,
    },
    trimmedHistoryTurns: 0,
    loggedKinds: new Set(),
  };
}

/** The sizes of the structures a sample reads — a plain shape so it is trivially testable. */
export interface SessionSizes {
  multiHistoryTurns: number;
  dualHistoryTurns: number;
  confidenceSamples: number;
  pendingTurns: number;
  pendingChars: number;
  audioBufferBytes: number;
  speakerAudioBytes: number;
  recoveryBufferBytes: number;
  recoveryBufferChunks: number;
  inFlightTurns: number;
}

export function recordHighWater(metrics: SessionMetrics, sizes: SessionSizes): void {
  metrics.samples += 1;
  const hw = metrics.highWater;
  for (const key of Object.keys(sizes) as Array<keyof SessionSizes>) {
    if (sizes[key] > hw[key]) hw[key] = sizes[key];
  }
}

/** Redacted, JSON-safe view: counters and byte sizes only. */
export function snapshotMetrics(metrics: SessionMetrics) {
  return {
    samples: metrics.samples,
    highWater: { ...metrics.highWater },
    boundHits: { ...metrics.boundHits },
    trimmedHistoryTurns: metrics.trimmedHistoryTurns,
  };
}
