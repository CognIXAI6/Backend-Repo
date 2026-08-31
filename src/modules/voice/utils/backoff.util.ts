export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction of the capped delay randomized either direction, e.g. 0.3 = ±30%. */
  jitterRatio: number;
}

export const PROVIDER_RECOVERY_MAX_ATTEMPTS = 3;

export const DEFAULT_PROVIDER_RECOVERY_BACKOFF: BackoffConfig = {
  baseDelayMs: 500,
  maxDelayMs: 4000,
  jitterRatio: 0.3,
};

/**
 * Delay before retry attempt `attemptIndex + 1` (1-based: pass 1 for the
 * delay before attempt 2, 2 for the delay before attempt 3, etc).
 */
export function computeBackoffDelayMs(
  attemptIndex: number,
  config: BackoffConfig = DEFAULT_PROVIDER_RECOVERY_BACKOFF,
): number {
  const exp = config.baseDelayMs * Math.pow(2, attemptIndex - 1);
  const capped = Math.min(exp, config.maxDelayMs);
  const jitter = capped * config.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
