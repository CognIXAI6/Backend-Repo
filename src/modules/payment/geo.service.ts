import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Countries whose users should pay via Flutterwave in local currency.
// Everyone not in this map pays via Stripe in USD.
export const AFRICAN_CURRENCY_MAP: Record<string, string> = {
  NG: 'NGN', // Nigeria
  GH: 'GHS', // Ghana
  KE: 'KES', // Kenya
  ZA: 'ZAR', // South Africa
  UG: 'UGX', // Uganda
  TZ: 'TZS', // Tanzania
  RW: 'RWF', // Rwanda
  ZM: 'ZMW', // Zambia
  EG: 'EGP', // Egypt
  ET: 'ETB', // Ethiopia
  SN: 'XOF', // Senegal
  CI: 'XOF', // Côte d'Ivoire
  CM: 'XAF', // Cameroon
  MA: 'MAD', // Morocco
  TN: 'TND', // Tunisia
  MZ: 'MZN', // Mozambique
  MU: 'MUR', // Mauritius
  GM: 'GMD', // Gambia
};

export type Provider = 'stripe' | 'flutterwave';

export interface CountryConfig {
  countryCode: string;
  currency: string;
  provider: Provider;
}

export function getCountryConfig(countryCode: string): CountryConfig {
  const currency = AFRICAN_CURRENCY_MAP[countryCode?.toUpperCase()];
  if (currency) {
    return { countryCode, currency, provider: 'flutterwave' };
  }
  return { countryCode, currency: 'USD', provider: 'stripe' };
}

@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  constructor(private configService: ConfigService) {}

  // Extracts the real client IP, accounting for reverse proxies (Render, Nginx, etc.)
  getClientIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return first.split(',')[0].trim();
    }
    return req.ip ?? '127.0.0.1';
  }

  async detectCountry(ip: string): Promise<string | null> {
    // Loopback / private IPs → skip (happens in local dev)
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return null;
    }

    const token = this.configService.get<string>('geo.ipinfoToken');

    try {
      const url = token
        ? `https://ipinfo.io/${ip}/json?token=${token}`
        : `https://ipinfo.io/${ip}/json`;

      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`ipinfo returned ${res.status}`);

      const data = (await res.json()) as { country?: string };
      return data.country ?? null;
    } catch (err) {
      this.logger.warn(`Geo detection failed for IP ${ip}: ${(err as Error).message}`);
      return null;
    }
  }
}
