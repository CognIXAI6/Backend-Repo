import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

export interface FlutterwavePaymentParams {
  txRef: string;
  amount: number;       // in major currency unit (e.g. NGN not kobo)
  currency: string;     // ISO 4217: NGN, GHS, KES …
  email: string;
  name: string;
  redirectUrl: string;
  meta: Record<string, string>;
  description?: string;
}

export interface FlutterwaveWebhookPayload {
  event: string;
  data: {
    id: number;
    tx_ref: string;
    flw_ref: string;
    amount: number;
    currency: string;
    status: string;
    customer: { id: number; email: string; name: string };
    meta: Record<string, string> | Array<{ metaname: string; metavalue: string }>;
  };
}

@Injectable()
export class FlutterwaveService {
  private readonly logger = new Logger(FlutterwaveService.name);
  private readonly baseUrl = 'https://api.flutterwave.com/v3';

  constructor(private configService: ConfigService) {}

  private get secretKey(): string {
    return this.configService.get<string>('flutterwave.secretKey') ?? '';
  }

  private get webhookSecret(): string {
    return this.configService.get<string>('flutterwave.webhookSecret') ?? '';
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    const json = (await res.json()) as { status: string; message: string; data: T };

    if (!res.ok || json.status !== 'success') {
      throw new Error(`Flutterwave API error: ${json.message ?? res.statusText}`);
    }

    return json.data;
  }

  async createPaymentLink(params: FlutterwavePaymentParams): Promise<string> {
    const data = await this.request<{ link: string }>('POST', '/payments', {
      tx_ref: params.txRef,
      amount: params.amount,
      currency: params.currency,
      redirect_url: params.redirectUrl,
      customer: {
        email: params.email,
        name: params.name,
      },
      customizations: {
        title: 'CognIX AI',
        description: params.description ?? 'CognIX subscription',
      },
      meta: params.meta,
    });

    return data.link;
  }

  // Flutterwave sends the configured secret hash in the verif-hash header.
  // Simple equality check — no HMAC needed (unlike Stripe).
  verifyWebhookSignature(secretHashHeader: string): boolean {
    if (!this.webhookSecret) return false;
    return secretHashHeader === this.webhookSecret;
  }

  // Always verify the transaction server-side — never trust the webhook payload amount alone.
  async verifyTransaction(transactionId: number): Promise<{
    status: string;
    amount: number;
    currency: string;
    txRef: string;
    meta: Record<string, string>;
  }> {
    const data = await this.request<any>('GET', `/transactions/${transactionId}/verify`);

    const rawMeta = data.meta ?? {};
    const meta: Record<string, string> = Array.isArray(rawMeta)
      ? Object.fromEntries(rawMeta.map((m: any) => [m.metaname, m.metavalue]))
      : rawMeta;

    return {
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      txRef: data.tx_ref,
      meta,
    };
  }

  // Parses meta from the webhook payload (Flutterwave can send it as array or object).
  parseMeta(raw: FlutterwaveWebhookPayload['data']['meta']): Record<string, string> {
    if (!raw) return {};
    if (Array.isArray(raw)) {
      return Object.fromEntries(raw.map((m) => [m.metaname, m.metavalue]));
    }
    return raw;
  }
}
