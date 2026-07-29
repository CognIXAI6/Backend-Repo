import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

@Injectable()
export class PushNotificationService implements OnModuleInit {
  private readonly logger = new Logger(PushNotificationService.name);
  private initialized = false;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    const serviceAccountJson = this.configService.get<string>('notifications.firebaseServiceAccount');
    if (!serviceAccountJson) {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
      return;
    }

    try {
      // Only initialize once even if the module is hot-reloaded.
      if (getApps().length === 0) {
        const serviceAccount = JSON.parse(serviceAccountJson);
        initializeApp({ credential: cert(serviceAccount) });
      }
      this.initialized = true;
      this.logger.log('Firebase push notifications initialized');
    } catch (err) {
      this.logger.error('Firebase initialization failed:', err);
    }
  }

  async registerToken(userId: string, token: string, platform: 'web' | 'android' | 'ios' = 'web'): Promise<void> {
    await this.knex('user_push_tokens')
      .insert({ user_id: userId, token, platform, last_used_at: new Date() })
      .onConflict(['user_id', 'token'])
      .merge({ platform, last_used_at: new Date() });
  }

  async removeToken(userId: string, token: string): Promise<void> {
    await this.knex('user_push_tokens').where({ user_id: userId, token }).delete();
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!this.initialized) return;

    const rows: { token: string }[] = await this.knex('user_push_tokens')
      .where({ user_id: userId })
      .select('token');

    if (rows.length === 0) return;

    const tokens = rows.map((r) => r.token);
    const message: MulticastMessage = {
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
      webpush: {
        notification: { title: payload.title, body: payload.body, icon: '/icon-192.png' },
      },
    };

    try {
      const response = await getMessaging().sendEachForMulticast(message);
      this.logger.log(
        `Push sent to user ${userId}: ${response.successCount} succeeded, ${response.failureCount} failed`,
      );

      // Remove stale tokens (invalid / unregistered) to keep the table clean.
      const staleTokens = response.responses
        .map((r, i) => (!r.success ? tokens[i] : null))
        .filter((t): t is string => t !== null);

      if (staleTokens.length > 0) {
        await this.knex('user_push_tokens')
          .where({ user_id: userId })
          .whereIn('token', staleTokens)
          .delete();
        this.logger.log(`Removed ${staleTokens.length} stale push token(s) for user ${userId}`);
      }
    } catch (err) {
      this.logger.error(`Push delivery failed for user ${userId}:`, err);
    }
  }
}
