import {
  Injectable,
  Inject,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createClerkClient, verifyToken as verifyClerkToken } from '@clerk/backend';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UsersService, User } from '@/modules/users/users.service';
import { EmailService } from '@/modules/email/email.service';
import { generateToken, addDays, isExpired, generateOtp, addMinutes } from '@/common';
import { SendOtpDto, VerifyOtpDto, ClerkSyncDto, RefreshTokenDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private clerkClient: ReturnType<typeof createClerkClient> | null = null;
  private clerkSecretKey: string | undefined;

  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
  ) {
    this.clerkSecretKey = this.configService.get<string>('clerk.secretKey');
    if (this.clerkSecretKey) {
      this.clerkClient = createClerkClient({ secretKey: this.clerkSecretKey });
    }
  }

  /**
   * Step 1: Send a 6-digit OTP to the provided email.
   *
   * Works for both new users (registration) and existing users (passwordless login).
   * If the user already exists we simply send a fresh OTP — no separate "login vs register"
   * distinction needed on the client.
   */
  async sendOtp(dto: SendOtpDto) {
    const email = dto.email.toLowerCase();

    // Invalidate any previous unused OTPs for this address
    await this.knex('registration_otps')
      .where('email', email)
      .andWhere('used', false)
      .update({ used: true });

    const otp = generateOtp(6);
    const hashedOtp = await bcrypt.hash(otp, 10);

    await this.knex('registration_otps').insert({
      email,
      token: hashedOtp,
      niche_id: dto.niche_id ?? null,
      expires_at: addMinutes(new Date(), 10),
    });

    const existingUser = await this.usersService.findByEmail(email);

    // Send email in the background — do not await so the client gets an
    // immediate response. The OTP is already persisted in the DB.
    const emailPromise = existingUser
      ? this.emailService.sendLoginOtpEmail(email, otp, existingUser.name ?? undefined)
      : this.emailService.sendRegistrationOtpEmail(email, otp);

    emailPromise.catch((err) =>
      this.logger.error(`Failed to send OTP email to ${email}:`, err),
    );

    return {
      message: 'A 6-digit verification code has been sent to your email.',
      isNewUser: !existingUser,
    };
  }

  /**
   * Step 2: Verify the OTP.
   *
   * - If the user does not exist yet → create account, save niche, return tokens.
   * - If the user already exists → mark email verified (if not already), return tokens.
   */
  async verifyOtp(dto: VerifyOtpDto) {
    const email = dto.email.toLowerCase();

    const record = await this.knex('registration_otps')
      .where('email', email)
      .andWhere('used', false)
      .orderBy('created_at', 'desc')
      .first();

    if (!record) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    if (isExpired(record.expires_at)) {
      throw new BadRequestException('Verification code has expired. Please request a new one.');
    }

    const isValid = await bcrypt.compare(dto.otp, record.token);
    if (!isValid) {
      throw new BadRequestException('Invalid verification code');
    }

    // Invalidate the used OTP
    await this.knex('registration_otps').where('id', record.id).update({ used: true });

    // Resolve niche: prefer the one on the VerifyOtpDto, fall back to the one stored with the OTP
    const resolvedNicheId = dto.niche_id ?? record.niche_id ?? null;

    let user = await this.usersService.findByEmail(email);

    if (!user) {
      // New user — create account
      user = await this.knex.transaction(async (trx) => {
        const [newUser] = await trx('users')
          .insert({
            email,
            password: null,
            auth_provider: 'email_otp',
            email_verified: true,
            // Niche provided at signup → onboarding is done immediately
            onboarding_status: resolvedNicheId ? 'completed' : 'in_progress',
          })
          .returning('*');

        if (resolvedNicheId) {
          await trx('user_fields').insert({
            user_id: newUser.id,
            field_id: resolvedNicheId,
            is_primary: true,
          });
        }

        return newUser;
      });
    } else {
      // Returning user — ensure email is verified
      if (!user.email_verified) {
        await this.usersService.update(user.id, { email_verified: true });
        user = (await this.usersService.findById(user.id))!;
      }

      // Attach niche if not already set and advance onboarding status
      if (resolvedNicheId) {
        const existingField = await this.knex('user_fields')
          .where('user_id', user.id)
          .andWhere('is_primary', true)
          .first();

        if (!existingField) {
          await this.knex('user_fields').insert({
            user_id: user.id,
            field_id: resolvedNicheId,
            is_primary: true,
          });
          // Niche just selected — mark onboarding complete
          await this.usersService.update(user.id, { onboarding_status: 'completed' });
          user = (await this.usersService.findById(user.id))!;
        }
      }
    }

    const tokens = await this.generateTokens(user!);

    return {
      user: this.usersService.sanitizeUser(user!),
      ...tokens,
    };
  }

  /**
   * Clerk OAuth sync — called by the frontend after the user completes Clerk's
   * OAuth flow.  We verify the Clerk session token, then find-or-create the
   * matching user in our own database and issue our own JWT pair.
   *
   * This ensures a single "user" record regardless of whether someone signed in
   * via Clerk OAuth or the email-OTP flow.
   */
  async clerkSync(dto: ClerkSyncDto) {
    if (!this.clerkClient) {
      throw new BadRequestException('Clerk integration is not configured on this server');
    }

    let clerkPayload: { sub: string };
    try {
      clerkPayload = await verifyClerkToken(dto.clerkToken, { secretKey: this.clerkSecretKey! }) as { sub: string };
    } catch {
      throw new UnauthorizedException('Invalid Clerk session token');
    }

    const clerkUserId = clerkPayload.sub;

    // Fetch the full user profile from Clerk so we have email + name
    const clerkUser = await this.clerkClient.users.getUser(clerkUserId);
    const primaryEmail = clerkUser.emailAddresses.find(
      (e) => e.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress?.toLowerCase();

    if (!primaryEmail) {
      throw new BadRequestException('Clerk account has no verified email address');
    }

    // 1. Try to find by clerk_user_id first (fastest path for returning OAuth users)
    let user = await this.usersService.findByClerkId(clerkUserId);

    if (!user) {
      // 2. Try to find by email (merges with an existing email-OTP account)
      user = await this.usersService.findByEmail(primaryEmail);

      if (user) {
        // Link the Clerk ID to the existing account
        user = await this.usersService.update(user.id, {
          clerk_user_id: clerkUserId,
          auth_provider: 'clerk_oauth',
          email_verified: true,
          avatar_url: user.avatar_url ?? (clerkUser.imageUrl || undefined),
        });
      } else {
        // 3. Brand-new user via OAuth
        user = await this.knex.transaction(async (trx) => {
          const [newUser] = await trx('users')
            .insert({
              email: primaryEmail,
              password: null,
              name: `${clerkUser.firstName ?? ''} ${clerkUser.lastName ?? ''}`.trim() || null,
              auth_provider: 'clerk_oauth',
              clerk_user_id: clerkUserId,
              avatar_url: clerkUser.imageUrl || null,
              email_verified: true,
              onboarding_status: dto.niche_id ? 'completed' : 'in_progress',
            })
            .returning('*');

          if (dto.niche_id) {
            await trx('user_fields').insert({
              user_id: newUser.id,
              field_id: dto.niche_id,
              is_primary: true,
            });
          }

          return newUser;
        });
      }
    }

    const tokens = await this.generateTokens(user!);

    return {
      user: this.usersService.sanitizeUser(user!),
      ...tokens,
    };
  }

  async refreshToken(dto: RefreshTokenDto) {
    const storedToken = await this.knex('refresh_tokens')
      .where('token', dto.refreshToken)
      .andWhere('revoked', false)
      .first();

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (isExpired(storedToken.expires_at)) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    const user = await this.usersService.findById(storedToken.user_id);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    await this.knex('refresh_tokens')
      .where('id', storedToken.id)
      .update({ revoked: true });

    return this.generateTokens(user);
  }

  async logout(userId: string, refreshToken: string) {
    await this.knex('refresh_tokens')
      .where('user_id', userId)
      .andWhere('token', refreshToken)
      .update({ revoked: true });

    return { message: 'Logged out successfully' };
  }

  private async generateTokens(user: User) {
    const payload = { sub: user.id, email: user.email };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get('jwt.secret'),
      expiresIn: this.configService.get('jwt.expiresIn'),
    });

    const refreshToken = generateToken(64);
    const refreshExpiresIn = this.configService.get('jwt.refreshExpiresIn');
    const expiresAt = addDays(new Date(), parseInt(refreshExpiresIn) || 30);

    await this.knex('refresh_tokens').insert({
      user_id: user.id,
      token: refreshToken,
      expires_at: expiresAt,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.configService.get('jwt.expiresIn'),
    };
  }
}
