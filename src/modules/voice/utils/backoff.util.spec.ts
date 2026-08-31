import { computeBackoffDelayMs, DEFAULT_PROVIDER_RECOVERY_BACKOFF } from './backoff.util';

describe('computeBackoffDelayMs', () => {
  const { baseDelayMs, maxDelayMs, jitterRatio } = DEFAULT_PROVIDER_RECOVERY_BACKOFF;

  it('grows across attempts before hitting the cap', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter at 0.5
    try {
      const first = computeBackoffDelayMs(1);
      const second = computeBackoffDelayMs(2);
      expect(second).toBeGreaterThan(first);
      expect(first).toBe(baseDelayMs);
      expect(second).toBe(baseDelayMs * 2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('never exceeds maxDelayMs plus the jitter margin', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(1); // max positive jitter
    try {
      const delay = computeBackoffDelayMs(10); // far beyond the cap pre-jitter
      expect(delay).toBeLessThanOrEqual(Math.round(maxDelayMs * (1 + jitterRatio)));
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('never returns a negative number even with extreme negative jitter', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0); // max negative jitter
    try {
      const delay = computeBackoffDelayMs(1);
      expect(delay).toBeGreaterThanOrEqual(0);
    } finally {
      randomSpy.mockRestore();
    }
  });
});
