import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { KNEX_CONNECTION } from '@/database/database.module';
import { FxService } from '../payment/fx.service';
import { EmailService } from '../email/email.service';

export type AdminRole = 'super_admin' | 'admin';
export type Period = '7d' | '30d' | '90d' | 'all';

function periodToDate(period: Period): Date | null {
  if (period === 'all') return null;
  const days = { '7d': 7, '30d': 30, '90d': 90 }[period];
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private fxService: FxService,
    private emailService: EmailService,
    @Inject(KNEX_CONNECTION) private knex: Knex,
  ) {}

  // ── Auth ───────────────────────────────────────────────────────────────────

  async login(email: string, password: string) {
    const admin = await this.knex('admins').where({ email: email.toLowerCase(), is_active: true }).first();
    if (!admin) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    await this.knex('admins').where('id', admin.id).update({ last_login_at: new Date() });

    const token = this.jwtService.sign(
      { sub: admin.id, email: admin.email, role: admin.role, type: 'admin' },
      { secret: this.configService.get<string>('jwt.secret'), expiresIn: '12h' },
    );

    return {
      accessToken: token,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    };
  }

  async getMe(adminId: string) {
    const admin = await this.knex('admins').where('id', adminId).first();
    if (!admin) throw new NotFoundException('Admin not found');
    return { id: admin.id, email: admin.email, name: admin.name, role: admin.role, lastLoginAt: admin.last_login_at };
  }

  async inviteAdmin(email: string, name: string, role: AdminRole, invitedById: string) {
    const existing = await this.knex('admins').where('email', email.toLowerCase()).first();
    if (existing) throw new ConflictException('An admin with this email already exists');

    const pending = await this.knex('admin_invitations')
      .where('email', email.toLowerCase())
      .whereNull('accepted_at')
      .where('expires_at', '>', new Date())
      .first();
    if (pending) throw new ConflictException('An invitation for this email is already pending');

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    await this.knex('admin_invitations').insert({
      email: email.toLowerCase(),
      name,
      token,
      invited_by: invitedById,
      role,
      expires_at: expiresAt,
    });

    const inviter = await this.knex('admins').where('id', invitedById).first();
    const inviterName = inviter?.name ?? 'A CognIX administrator';

    const adminPortalUrl = this.configService.get<string>('app.adminPortalUrl')
      ?? `${this.configService.get<string>('app.frontendUrl')}/admin`;
    const acceptUrl = `${adminPortalUrl}/accept-invite?token=${token}`;

    this.emailService
      .sendAdminInvitationEmail({ to: email, name, invitedByName: inviterName, role, token, acceptUrl, expiresAt })
      .catch((err) => this.logger.error(`Failed to send invitation email to ${email}:`, err));

    this.logger.log(`Admin invitation created for ${email} by admin ${invitedById}`);
    return { message: `Invitation sent to ${email}`, token, expiresAt };
  }

  async resendPendingInvitations(requesterId: string) {
    const pending = await this.knex('admin_invitations')
      .whereNull('accepted_at')
      .select('*');

    if (pending.length === 0) {
      return { sent: 0, refreshed: 0, failed: 0, skipped: 0, details: [] };
    }

    const inviter = await this.knex('admins').where('id', requesterId).first();
    const inviterName = inviter?.name ?? 'A CognIX administrator';

    const adminPortalUrl =
      this.configService.get<string>('app.adminPortalUrl') ??
      `${this.configService.get<string>('app.frontendUrl')}/admin`;

    const now = new Date();
    let sent = 0;
    let refreshed = 0;
    let failed = 0;
    const details: Array<{ email: string; status: string; reason?: string }> = [];

    for (const inv of pending) {
      try {
        let token = inv.token;
        let expiresAt: Date = inv.expires_at;

        // If the invitation has expired, issue a fresh token and extend the expiry.
        if (new Date(inv.expires_at) < now) {
          token = randomBytes(32).toString('hex');
          expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
          await this.knex('admin_invitations')
            .where('id', inv.id)
            .update({ token, expires_at: expiresAt });
          refreshed++;
        }

        const acceptUrl = `${adminPortalUrl}/accept-invite?token=${token}`;

        await this.emailService.sendAdminInvitationEmail({
          to: inv.email,
          name: inv.name,
          invitedByName: inviterName,
          role: inv.role,
          token,
          acceptUrl,
          expiresAt,
        });

        sent++;
        details.push({ email: inv.email, status: 'sent' });
      } catch (err) {
        failed++;
        details.push({ email: inv.email, status: 'failed', reason: (err as Error).message });
        this.logger.error(`Failed to resend invitation to ${inv.email}:`, err);
      }
    }

    this.logger.log(
      `Resend pending invitations: total=${pending.length}, sent=${sent}, refreshed=${refreshed}, failed=${failed}`,
    );

    return { sent, refreshed, failed, skipped: 0, total: pending.length, details };
  }

  async acceptInvite(token: string, password: string) {
    const invitation = await this.knex('admin_invitations')
      .where({ token })
      .whereNull('accepted_at')
      .where('expires_at', '>', new Date())
      .first();

    if (!invitation) throw new BadRequestException('Invalid or expired invitation token');

    const existing = await this.knex('admins').where('email', invitation.email).first();
    if (existing) throw new ConflictException('Admin account already exists for this email');

    const password_hash = await bcrypt.hash(password, 12);

    const [admin] = await this.knex('admins')
      .insert({
        email: invitation.email,
        name: invitation.name,
        password_hash,
        role: invitation.role,
        invited_by: invitation.invited_by,
      })
      .returning(['id', 'email', 'name', 'role']);

    await this.knex('admin_invitations').where('id', invitation.id).update({ accepted_at: new Date() });

    const accessToken = this.jwtService.sign(
      { sub: admin.id, email: admin.email, role: admin.role, type: 'admin' },
      { secret: this.configService.get<string>('jwt.secret'), expiresIn: '12h' },
    );

    return { accessToken, admin };
  }

  async createFirstAdmin(email: string, name: string, password: string) {
    const count = await this.knex('admins').count('id as count').first();
    if (Number(count?.count) > 0) {
      throw new ConflictException('Admin account already exists. Use the invite flow.');
    }
    const password_hash = await bcrypt.hash(password, 12);
    const [admin] = await this.knex('admins')
      .insert({ email: email.toLowerCase(), name, password_hash, role: 'super_admin' })
      .returning(['id', 'email', 'name', 'role']);
    return { message: 'Super admin created', admin };
  }

  async listAdmins() {
    return this.knex('admins')
      .select('id', 'email', 'name', 'role', 'is_active', 'last_login_at', 'created_at')
      .orderBy('created_at', 'asc');
  }

  async toggleAdminStatus(adminId: string, requesterId: string) {
    const admin = await this.knex('admins').where('id', adminId).first();
    if (!admin) throw new NotFoundException('Admin not found');
    if (admin.id === requesterId) throw new BadRequestException('You cannot deactivate your own account');
    await this.knex('admins').where('id', adminId).update({ is_active: !admin.is_active });
    return { id: adminId, is_active: !admin.is_active };
  }

  // ── User management ────────────────────────────────────────────────────────

  async getUsers(params: {
    page: number;
    limit: number;
    search?: string;
    tier?: string;
    authProvider?: string;
  }) {
    const { page, limit, search, tier, authProvider } = params;
    const offset = (page - 1) * limit;

    let query = this.knex('users').whereNull('deleted_at');

    if (search) {
      query = query.where((q) =>
        q.whereILike('email', `%${search}%`).orWhereILike('name', `%${search}%`),
      );
    }
    if (tier) query = query.where('subscription_tier', tier);
    if (authProvider) query = query.where('auth_provider', authProvider);

    const [{ total }] = await query.clone().count('id as total');
    const users = await query
      .select(
        'id', 'email', 'name', 'subscription_tier', 'auth_provider',
        'onboarding_status', 'email_verified', 'stripe_customer_id',
        'created_at', 'updated_at',
      )
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    return {
      data: users,
      meta: { total: Number(total), page, limit, totalPages: Math.ceil(Number(total) / limit) },
    };
  }

  async getUserDetails(userId: string) {
    const user = await this.knex('users').where('id', userId).whereNull('deleted_at').first();
    if (!user) throw new NotFoundException('User not found');

    const [subscription, conversationStats, voiceStats] = await Promise.all([
      this.knex('subscriptions')
        .where('user_id', userId)
        .whereIn('status', ['active', 'trialing', 'past_due'])
        .orderBy('created_at', 'desc')
        .first(),

      this.knex('conversations')
        .where('user_id', userId)
        .whereNull('deleted_at')
        .select(
          this.knex.raw('COUNT(id) as total_conversations'),
          this.knex.raw('SUM(total_messages) as total_messages'),
          this.knex.raw('MAX(last_activity_at) as last_active'),
        )
        .first(),

      this.knex('conversation_messages as cm')
        .join('conversations as c', 'c.id', 'cm.conversation_id')
        .where('c.user_id', userId)
        .whereNull('c.deleted_at')
        .select(
          this.knex.raw('COALESCE(SUM(cm.tokens_used), 0) as total_tokens'),
          this.knex.raw('COALESCE(SUM(cm.audio_duration_ms), 0) as total_audio_ms'),
          this.knex.raw('COUNT(CASE WHEN cm.audio_url IS NOT NULL THEN 1 END) as voice_messages'),
        )
        .first(),
    ]);

    const totalAudioMinutes = Number(voiceStats?.total_audio_ms ?? 0) / 60000;
    const totalTokens = Number(voiceStats?.total_tokens ?? 0);

    return {
      user: {
        id: user.id, email: user.email, name: user.name,
        subscriptionTier: user.subscription_tier,
        authProvider: user.auth_provider,
        onboardingStatus: user.onboarding_status,
        emailVerified: user.email_verified,
        stripeCustomerId: user.stripe_customer_id,
        createdAt: user.created_at,
      },
      subscription: subscription ?? null,
      usage: {
        totalConversations: Number(conversationStats?.total_conversations ?? 0),
        totalMessages: Number(conversationStats?.total_messages ?? 0),
        lastActiveAt: conversationStats?.last_active ?? null,
        totalTokensUsed: totalTokens,
        estimatedAiCostUsd: Number(((totalTokens / 1_000_000) * 9).toFixed(4)), // ~$9/1M tokens blended
        totalAudioMinutes: Number(totalAudioMinutes.toFixed(2)),
        estimatedDeepgramCostUsd: Number((totalAudioMinutes * 0.0043).toFixed(4)),
        voiceMessages: Number(voiceStats?.voice_messages ?? 0),
      },
    };
  }

  async updateUserTier(userId: string, tier: 'free' | 'premium') {
    const user = await this.knex('users').where('id', userId).first();
    if (!user) throw new NotFoundException('User not found');
    await this.knex('users').where('id', userId).update({ subscription_tier: tier, updated_at: new Date() });
    return { id: userId, subscription_tier: tier };
  }

  async toggleUserStatus(userId: string) {
    const user = await this.knex('users').where('id', userId).first();
    if (!user) throw new NotFoundException('User not found');
    const deletedAt = user.deleted_at ? null : new Date();
    await this.knex('users').where('id', userId).update({ deleted_at: deletedAt, updated_at: new Date() });
    return { id: userId, active: deletedAt === null };
  }

  // ── Revenue analytics ──────────────────────────────────────────────────────

  async getRevenueOverview(period: Period, displayCurrency: string) {
    const since = periodToDate(period);

    let subQuery = this.knex('subscriptions as s')
      .join('subscription_plans as sp', 'sp.billing_cycle', 's.billing_cycle')
      .whereIn('s.status', ['active', 'trialing', 'canceled']);

    if (since) subQuery = subQuery.where('s.created_at', '>=', since);

    const rows = await subQuery.select(
      this.knex.raw(`CASE WHEN s.stripe_subscription_id LIKE 'flw-%' THEN 'flutterwave' ELSE 'stripe' END as provider`),
      's.billing_cycle',
      's.status',
      's.created_at',
      'sp.amount_cents',
    );

    const usdRate = displayCurrency === 'USD' ? 1 : await this.fxService.getRate('USD', displayCurrency);

    let totalUsd = 0;
    let stripeUsd = 0;
    let flutterwaveUsd = 0;
    let stripeCount = 0;
    let flutterwaveCount = 0;

    const monthlyTrend: Record<string, number> = {};

    for (const row of rows) {
      const amountUsd = row.amount_cents / 100;
      totalUsd += amountUsd;
      const month = new Date(row.created_at).toISOString().slice(0, 7);
      monthlyTrend[month] = (monthlyTrend[month] ?? 0) + amountUsd;

      if (row.provider === 'stripe') { stripeUsd += amountUsd; stripeCount++; }
      else { flutterwaveUsd += amountUsd; flutterwaveCount++; }
    }

    const convert = (usd: number) => Number((usd * usdRate).toFixed(2));
    const formatted = (usd: number) => this.fxService.formatAmount(Math.round(usd * usdRate * 100), displayCurrency);

    const trend = Object.entries(monthlyTrend)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, usd]) => ({ month, amount: convert(usd), display: formatted(usd) }));

    // Subscription tier breakdown
    const tierCounts = await this.knex('users')
      .whereNull('deleted_at')
      .select('subscription_tier')
      .count('id as count')
      .groupBy('subscription_tier');

    return {
      displayCurrency,
      period,
      total: { amount: convert(totalUsd), display: formatted(totalUsd), subscriptions: rows.length },
      stripe: { amount: convert(stripeUsd), display: formatted(stripeUsd), subscriptions: stripeCount },
      flutterwave: { amount: convert(flutterwaveUsd), display: formatted(flutterwaveUsd), subscriptions: flutterwaveCount },
      trend,
      tierBreakdown: Object.fromEntries(tierCounts.map((r: any) => [r.subscription_tier, Number(r.count)])),
    };
  }

  async getTransactions(params: { page: number; limit: number; displayCurrency: string; provider?: string }) {
    const { page, limit, displayCurrency, provider } = params;
    const offset = (page - 1) * limit;

    let query = this.knex('subscriptions as s')
      .join('users as u', 'u.id', 's.user_id')
      .join('subscription_plans as sp', 'sp.billing_cycle', 's.billing_cycle');

    if (provider === 'stripe') query = query.whereRaw(`s.stripe_subscription_id NOT LIKE 'flw-%'`);
    if (provider === 'flutterwave') query = query.whereRaw(`s.stripe_subscription_id LIKE 'flw-%'`);

    const [{ total }] = await query.clone().count('s.id as total');

    const rows = await query
      .select(
        's.id', 's.stripe_subscription_id', 's.billing_cycle', 's.status',
        's.current_period_start', 's.current_period_end', 's.created_at',
        'sp.amount_cents',
        'u.id as user_id', 'u.email', 'u.name',
        this.knex.raw(`CASE WHEN s.stripe_subscription_id LIKE 'flw-%' THEN 'flutterwave' ELSE 'stripe' END as provider`),
      )
      .orderBy('s.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const usdRate = displayCurrency === 'USD' ? 1 : await this.fxService.getRate('USD', displayCurrency);

    const data = rows.map((r: any) => {
      const amountDisplay = this.fxService.formatAmount(Math.round((r.amount_cents / 100) * usdRate * 100), displayCurrency);
      return {
        id: r.id, provider: r.provider, billingCycle: r.billing_cycle, status: r.status,
        amountUsd: r.amount_cents / 100,
        amountDisplay,
        user: { id: r.user_id, email: r.email, name: r.name },
        periodStart: r.current_period_start, periodEnd: r.current_period_end,
        createdAt: r.created_at,
      };
    });

    return { data, meta: { total: Number(total), page, limit, totalPages: Math.ceil(Number(total) / limit) } };
  }

  async getRevenueByCurrency(displayCurrency: string) {
    // Stripe subscriptions count as USD; Flutterwave subs need a per-currency lookup.
    const allSubs = await this.knex('subscriptions as s')
      .join('subscription_plans as sp', 'sp.billing_cycle', 's.billing_cycle')
      .whereIn('s.status', ['active', 'trialing', 'canceled'])
      .select(
        this.knex.raw(`CASE WHEN s.stripe_subscription_id LIKE 'flw-%' THEN 'flutterwave' ELSE 'stripe' END as provider`),
        'sp.amount_cents',
        'u.email',
      )
      .join('users as u', 'u.id', 's.user_id');

    const usdRate = displayCurrency === 'USD' ? 1 : await this.fxService.getRate('USD', displayCurrency);

    const stripeRows = allSubs.filter((r: any) => r.provider === 'stripe');
    const flwRows = allSubs.filter((r: any) => r.provider === 'flutterwave');

    const stripeUsd = stripeRows.reduce((sum: number, r: any) => sum + r.amount_cents / 100, 0);
    const flwUsd = flwRows.reduce((sum: number, r: any) => sum + r.amount_cents / 100, 0);

    // Get live rates for all African currencies to show breakdown
    const africanCurrencies = ['NGN', 'GHS', 'KES', 'ZAR', 'UGX', 'TZS'];
    const rateData = await this.fxService.getAllRates();

    const africanBreakdown = africanCurrencies.map((cur) => {
      const rate = rateData.rates[cur] ?? 1;
      const amountLocal = flwUsd * rate;
      return {
        currency: cur,
        estimatedAmount: Number(amountLocal.toFixed(2)),
        display: this.fxService.formatAmount(Math.round(amountLocal * 100), cur),
      };
    });

    const convert = (usd: number) => Number((usd * usdRate).toFixed(2));
    const fmt = (usd: number) => this.fxService.formatAmount(Math.round(usd * usdRate * 100), displayCurrency);

    return {
      displayCurrency,
      stripe: {
        currency: 'USD',
        userCount: stripeRows.length,
        totalUsd: Number(stripeUsd.toFixed(2)),
        totalDisplay: fmt(stripeUsd),
      },
      flutterwave: {
        userCount: flwRows.length,
        totalUsd: Number(flwUsd.toFixed(2)),
        totalDisplay: fmt(flwUsd),
        byLocalCurrency: africanBreakdown,
      },
      combinedTotalDisplay: fmt(stripeUsd + flwUsd),
      combinedTotalConverted: convert(stripeUsd + flwUsd),
    };
  }

  // ── App analytics ──────────────────────────────────────────────────────────

  async getAppOverview(period: Period) {
    const since = periodToDate(period);

    const [totalUsers, newUsers, activeUsers, premiumUsers, totalConversations, newConversations] =
      await Promise.all([
        this.knex('users').whereNull('deleted_at').count('id as c').first(),

        since
          ? this.knex('users').whereNull('deleted_at').where('created_at', '>=', since).count('id as c').first()
          : Promise.resolve({ c: 0 }),

        this.knex('users as u')
          .join('conversations as c', 'c.user_id', 'u.id')
          .whereNull('u.deleted_at')
          .whereNull('c.deleted_at')
          .modify((q) => { if (since) q.where('c.last_activity_at', '>=', since); })
          .countDistinct('u.id as c')
          .first(),

        this.knex('users').where('subscription_tier', 'premium').whereNull('deleted_at').count('id as c').first(),

        this.knex('conversations').whereNull('deleted_at').count('id as c').first(),

        since
          ? this.knex('conversations').whereNull('deleted_at').where('created_at', '>=', since).count('id as c').first()
          : Promise.resolve({ c: 0 }),
      ]);

    // Signup trend
    const signupTrend = await this.knex('users')
      .whereNull('deleted_at')
      .modify((q) => { if (since) q.where('created_at', '>=', since); })
      .select(this.knex.raw(`TO_CHAR(created_at, 'YYYY-MM-DD') as date`))
      .count('id as signups')
      .groupByRaw(`TO_CHAR(created_at, 'YYYY-MM-DD')`)
      .orderBy('date', 'asc');

    return {
      period,
      users: {
        total: Number(totalUsers?.c ?? 0),
        new: Number(newUsers?.c ?? 0),
        active: Number(activeUsers?.c ?? 0),
        premium: Number(premiumUsers?.c ?? 0),
        free: Number(totalUsers?.c ?? 0) - Number(premiumUsers?.c ?? 0),
        conversionRate: totalUsers?.c
          ? Number(((Number(premiumUsers?.c ?? 0) / Number(totalUsers?.c)) * 100).toFixed(1))
          : 0,
      },
      conversations: {
        total: Number(totalConversations?.c ?? 0),
        new: Number(newConversations?.c ?? 0),
      },
      signupTrend: signupTrend.map((r: any) => ({ date: r.date, signups: Number(r.signups) })),
    };
  }

  async getAiUsage(period: Period, displayCurrency: string) {
    const since = periodToDate(period);

    let query = this.knex('conversation_messages as cm')
      .join('conversations as c', 'c.id', 'cm.conversation_id')
      .join('users as u', 'u.id', 'c.user_id')
      .whereNull('c.deleted_at')
      .where('cm.role', 'assistant');

    if (since) query = query.where('cm.created_at', '>=', since);

    const [overall, perUser, daily] = await Promise.all([
      query.clone()
        .select(
          this.knex.raw('COALESCE(SUM(cm.tokens_used), 0) as total_tokens'),
          this.knex.raw('COUNT(cm.id) as total_responses'),
          this.knex.raw('COALESCE(AVG(cm.latency_ms), 0) as avg_latency_ms'),
        )
        .first(),

      query.clone()
        .select(
          'u.id', 'u.email', 'u.name',
          this.knex.raw('COALESCE(SUM(cm.tokens_used), 0) as tokens'),
          this.knex.raw('COUNT(cm.id) as responses'),
        )
        .groupBy('u.id', 'u.email', 'u.name')
        .orderBy('tokens', 'desc')
        .limit(20),

      query.clone()
        .select(
          this.knex.raw(`TO_CHAR(cm.created_at, 'YYYY-MM-DD') as date`),
          this.knex.raw('COALESCE(SUM(cm.tokens_used), 0) as tokens'),
          this.knex.raw('COUNT(cm.id) as responses'),
        )
        .groupByRaw(`TO_CHAR(cm.created_at, 'YYYY-MM-DD')`)
        .orderBy('date', 'asc'),
    ]);

    const totalTokens = Number(overall?.total_tokens ?? 0);
    const estimatedCostUsd = (totalTokens / 1_000_000) * 9;
    const rate = displayCurrency === 'USD' ? 1 : await this.fxService.getRate('USD', displayCurrency);

    return {
      period,
      displayCurrency,
      overall: {
        totalTokens,
        totalResponses: Number(overall?.total_responses ?? 0),
        avgLatencyMs: Number(Number(overall?.avg_latency_ms ?? 0).toFixed(0)),
        estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
        estimatedCostDisplay: this.fxService.formatAmount(Math.round(estimatedCostUsd * rate * 100), displayCurrency),
      },
      topUsers: perUser.map((r: any) => ({
        userId: r.id, email: r.email, name: r.name,
        tokens: Number(r.tokens), responses: Number(r.responses),
        estimatedCostUsd: Number(((Number(r.tokens) / 1_000_000) * 9).toFixed(4)),
      })),
      dailyTrend: daily.map((r: any) => ({
        date: r.date, tokens: Number(r.tokens), responses: Number(r.responses),
      })),
    };
  }

  async getVoiceUsage(period: Period, displayCurrency: string) {
    const since = periodToDate(period);

    let query = this.knex('conversation_messages as cm')
      .join('conversations as c', 'c.id', 'cm.conversation_id')
      .join('users as u', 'u.id', 'c.user_id')
      .whereNull('c.deleted_at')
      .whereNotNull('cm.audio_url');

    if (since) query = query.where('cm.created_at', '>=', since);

    const [overall, perUser, daily] = await Promise.all([
      query.clone()
        .select(
          this.knex.raw('COALESCE(SUM(cm.audio_duration_ms), 0) as total_ms'),
          this.knex.raw('COUNT(cm.id) as total_clips'),
        )
        .first(),

      query.clone()
        .select(
          'u.id', 'u.email', 'u.name',
          this.knex.raw('COALESCE(SUM(cm.audio_duration_ms), 0) as total_ms'),
          this.knex.raw('COUNT(cm.id) as clips'),
        )
        .groupBy('u.id', 'u.email', 'u.name')
        .orderBy('total_ms', 'desc')
        .limit(20),

      query.clone()
        .select(
          this.knex.raw(`TO_CHAR(cm.created_at, 'YYYY-MM-DD') as date`),
          this.knex.raw('COALESCE(SUM(cm.audio_duration_ms), 0) as total_ms'),
          this.knex.raw('COUNT(cm.id) as clips'),
        )
        .groupByRaw(`TO_CHAR(cm.created_at, 'YYYY-MM-DD')`)
        .orderBy('date', 'asc'),
    ]);

    const totalMinutes = Number(overall?.total_ms ?? 0) / 60000;
    const estimatedCostUsd = totalMinutes * 0.0043; // Deepgram Nova-2 rate
    const rate = displayCurrency === 'USD' ? 1 : await this.fxService.getRate('USD', displayCurrency);

    return {
      period,
      displayCurrency,
      overall: {
        totalMinutes: Number(totalMinutes.toFixed(2)),
        totalAudioHours: Number((totalMinutes / 60).toFixed(2)),
        totalClips: Number(overall?.total_clips ?? 0),
        estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
        estimatedCostDisplay: this.fxService.formatAmount(Math.round(estimatedCostUsd * rate * 100), displayCurrency),
      },
      topUsers: perUser.map((r: any) => {
        const mins = Number(r.total_ms) / 60000;
        return {
          userId: r.id, email: r.email, name: r.name,
          minutes: Number(mins.toFixed(2)), clips: Number(r.clips),
          estimatedCostUsd: Number((mins * 0.0043).toFixed(4)),
        };
      }),
      dailyTrend: daily.map((r: any) => ({
        date: r.date, minutes: Number((Number(r.total_ms) / 60000).toFixed(2)), clips: Number(r.clips),
      })),
    };
  }

  async getConversationAnalytics(period: Period) {
    const since = periodToDate(period);

    const [overview, byMode, daily] = await Promise.all([
      this.knex('conversations')
        .whereNull('deleted_at')
        .modify((q) => { if (since) q.where('created_at', '>=', since); })
        .select(
          this.knex.raw('COUNT(id) as total'),
          this.knex.raw('COALESCE(SUM(total_messages), 0) as total_messages'),
          this.knex.raw('COALESCE(AVG(total_messages), 0) as avg_messages'),
        )
        .first(),

      this.knex('conversations')
        .whereNull('deleted_at')
        .modify((q) => { if (since) q.where('created_at', '>=', since); })
        .select('mode')
        .count('id as count')
        .groupBy('mode'),

      this.knex('conversations')
        .whereNull('deleted_at')
        .modify((q) => { if (since) q.where('created_at', '>=', since); })
        .select(this.knex.raw(`TO_CHAR(created_at, 'YYYY-MM-DD') as date`))
        .count('id as conversations')
        .groupByRaw(`TO_CHAR(created_at, 'YYYY-MM-DD')`)
        .orderBy('date', 'asc'),
    ]);

    return {
      period,
      total: Number(overview?.total ?? 0),
      totalMessages: Number(overview?.total_messages ?? 0),
      avgMessagesPerConversation: Number(Number(overview?.avg_messages ?? 0).toFixed(1)),
      byMode: Object.fromEntries(byMode.map((r: any) => [r.mode, Number(r.count)])),
      dailyTrend: daily.map((r: any) => ({ date: r.date, count: Number(r.conversations) })),
    };
  }

  async getErrorLogs(params: { page: number; limit: number; source?: string; severity?: string }) {
    const { page, limit, source, severity } = params;
    const offset = (page - 1) * limit;

    let query = this.knex('error_logs');
    if (source) query = query.where('source', source);
    if (severity) query = query.where('severity', severity);

    const [countRow, rows, breakdown] = await Promise.all([
      query.clone().count('id as total').first() as unknown as Promise<{ total: string | number }>,
      query.clone().orderBy('created_at', 'desc').limit(limit).offset(offset),
      this.knex('error_logs')
        .select('source', 'severity')
        .count('id as count')
        .groupBy('source', 'severity')
        .orderBy('count', 'desc'),
    ]);

    const total = Number(countRow?.total ?? 0);
    return {
      data: rows,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      breakdown: breakdown.map((r: any) => ({ source: r.source, severity: r.severity, count: Number(r.count) })),
    };
  }
}
