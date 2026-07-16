import { Injectable, Logger } from '@nestjs/common';

interface RateCache {
  rates: Record<string, number>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private cache: RateCache | null = null;

  // Returns how many units of `to` equal 1 unit of `from`.
  // Example: getRate('USD', 'NGN') → 1583  (1 USD = ₦1,583)
  async getRate(from: string, to: string): Promise<number> {
    if (from === to) return 1;
    const rates = await this.getRates(); // always USD-based

    if (from === 'USD') return rates[to] ?? 1;
    if (to === 'USD') return 1 / (rates[from] ?? 1);

    // Cross rate: from → USD → to
    const fromRate = rates[from] ?? 1;
    const toRate = rates[to] ?? 1;
    return toRate / fromRate;
  }

  // Returns a snapshot of all rates for the admin FX preview endpoint.
  async getAllRates(): Promise<{ base: string; rates: Record<string, number>; cachedAt: Date | null }> {
    const rates = await this.getRates();
    return {
      base: 'USD',
      rates,
      cachedAt: this.cache ? new Date(this.cache.fetchedAt) : null,
    };
  }

  private async getRates(): Promise<Record<string, number>> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.rates;
    }

    try {
      // open.er-api.com — free, no API key, updates daily
      const res = await fetch('https://open.er-api.com/v6/latest/USD', {
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) throw new Error(`FX API returned ${res.status}`);

      const data = (await res.json()) as { rates: Record<string, number> };
      this.cache = { rates: data.rates, fetchedAt: Date.now() };
      this.logger.log('FX rates refreshed from open.er-api.com');
      return this.cache.rates;
    } catch (err) {
      this.logger.error(`FX rate fetch failed: ${(err as Error).message}`);
      // Return stale cache if available rather than failing
      if (this.cache) return this.cache.rates;
      // Last resort fallback — prevents full outage if FX API is down
      return { NGN: 1600, GHS: 15.8, KES: 130, ZAR: 18.5, USD: 1, GBP: 0.79, EUR: 0.92 };
    }
  }

  // Converts a USD amount (in cents) to the target currency's minor unit.
  // Example: convertFromUsdCents(800, 'NGN', 1583) → 1_266_400 kobo
  convertFromUsdCents(usdCents: number, toCurrency: string, rate: number): number {
    if (toCurrency === 'USD') return usdCents;
    // usdCents / 100 = USD dollars → × rate = foreign major units → × 100 = minor units
    return Math.round((usdCents / 100) * rate * 100);
  }

  // Formats an amount (in minor units) as a human-readable currency string.
  formatAmount(amountMinorUnits: number, currency: string): string {
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(amountMinorUnits / 100);
    } catch {
      return `${currency} ${(amountMinorUnits / 100).toLocaleString()}`;
    }
  }
}
