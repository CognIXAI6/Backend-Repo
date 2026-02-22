import {
  Injectable,
  Inject,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UsersService, User } from '@/modules/users/users.service';
import { EmailService } from '@/modules/email/email.service';
import { PaymentService } from '@/modules/payment/payment.service';
import { generateToken, addHours, addDays, isExpired, generateOtp, addMinutes } from '@/common';
import {
  SignupDto,
  LoginDto,
  VerifyEmailDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  RefreshTokenDto,
  VerifyOtpDto,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
    private paymentService: PaymentService,
  ) {}

  async signup(dto: SignupDto) {
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    return this.knex.transaction(async (trx) => {
      // Create user
      const [user] = await trx('users')
        .insert({
          email: dto.email.toLowerCase(),
          password: hashedPassword,
        })
        .returning('*');

      // Create Stripe customer
      // const customer = await this.paymentService.createCustomer(user.email);
      // await trx('users')
      //   .where('id', user.id)
      //   .update({ stripe_customer_id: customer.id });

      // Create verification token
      const token = generateToken();
      await trx('email_verifications').insert({
        user_id: user.id,
        token,
        expires_at: addHours(new Date(), 24),
      });

      // Send verification email
      await this.emailService.sendVerificationEmail(user.email, token);

      return {
        message: 'Account created. Please check your email to verify your account.',
        userId: user.id,
        token
      };
    });
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.email_verified) {
      throw new BadRequestException('Please verify your email before logging in');
    }

    const tokens = await this.generateTokens(user);

    return {
      user: this.usersService.sanitizeUser(user),
      ...tokens,
    };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const verification = await this.knex('email_verifications')
      .where('token', dto.token)
      .andWhere('used', false)
      .first();

    if (!verification) {
      throw new BadRequestException('Invalid verification token');
    }

    if (isExpired(verification.expires_at)) {
      throw new BadRequestException('Verification token has expired');
    }

    await this.knex.transaction(async (trx) => {
      await trx('users')
        .where('id', verification.user_id)
        .update({ email_verified: true, updated_at: new Date() });

      await trx('email_verifications')
        .where('id', verification.id)
        .update({ used: true });
    });

    return { message: 'Email verified successfully' };
  }

  async resendVerificationEmail(email: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      // Don't reveal if user exists
      return { message: 'If an account exists, a verification email has been sent' };
    }

    if (user.email_verified) {
      throw new BadRequestException('Email is already verified');
    }

    // Invalidate old tokens
    await this.knex('email_verifications')
      .where('user_id', user.id)
      .update({ used: true });

    // Create new token
    const token = generateToken();
    await this.knex('email_verifications').insert({
      user_id: user.id,
      token,
      expires_at: addHours(new Date(), 24),
    });

    await this.emailService.sendVerificationEmail(user.email, token);

    return { message: 'Verification email sent' };
  }

async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.usersService.findByEmail(dto.email);
    
    // Always return success to prevent email enumeration
    if (!user) {
      return { message: 'If an account exists, a password reset OTP has been sent' };
    }

    // Invalidate old OTPs
    await this.knex('password_resets')
      .where('user_id', user.id)
      .update({ used: true });

    // Generate 6-digit OTP
    const otp = generateOtp(6);
    
    // Hash the OTP before storing (for security)
    const hashedOtp = await bcrypt.hash(otp, 10);
    
    await this.knex('password_resets').insert({
      user_id: user.id,
      token: hashedOtp,
      expires_at: addMinutes(new Date(), 10), // OTP valid for 10 minutes
    });

    // Send OTP email
    await this.emailService.sendPasswordResetOtpEmail(user.email, otp);

    return { message: 'If an account exists, a password reset OTP has been sent' };
  }

  async verifyResetOtp(dto: VerifyOtpDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new BadRequestException('Invalid OTP');
    }

    const resetRecord = await this.knex('password_resets')
      .where('user_id', user.id)
      .andWhere('used', false)
      .orderBy('created_at', 'desc')
      .first();

    if (!resetRecord) {
      throw new BadRequestException('Invalid OTP');
    }

    if (isExpired(resetRecord.expires_at)) {
      throw new BadRequestException('OTP has expired');
    }

    // Verify OTP
    const isValidOtp = await bcrypt.compare(dto.otp, resetRecord.token);
    if (!isValidOtp) {
      throw new BadRequestException('Invalid OTP');
    }

    return { message: 'OTP verified successfully', verified: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new BadRequestException('Invalid request');
    }
    // Check if new password matches the old password
    const isSamePassword = await bcrypt.compare(dto.password, user.password);
    if (isSamePassword) {
      throw new BadRequestException('New password must be different from your current password');
    }
    const resetRecord = await this.knex('password_resets')
      .where('user_id', user.id)
      .andWhere('used', false)
      .orderBy('created_at', 'desc')
      .first();

    if (!resetRecord) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    if (isExpired(resetRecord.expires_at)) {
      throw new BadRequestException('OTP has expired');
    }

    // Verify OTP
    const isValidOtp = await bcrypt.compare(dto.otp, resetRecord.token);
    if (!isValidOtp) {
      throw new BadRequestException('Invalid OTP');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    await this.knex.transaction(async (trx) => {
      // Update password
      await trx('users')
        .where('id', user.id)
        .update({ password: hashedPassword, updated_at: new Date() });

      // Mark OTP as used
      await trx('password_resets')
        .where('id', resetRecord.id)
        .update({ used: true });

      // Revoke all refresh tokens
      await trx('refresh_tokens')
        .where('user_id', user.id)
        .update({ revoked: true });
    });

    return { message: 'Password reset successfully' };
  }

  async resendResetOtp(dto: ForgotPasswordDto) {
    // Reuse forgotPassword logic
    return this.forgotPassword(dto);
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

    // Revoke old token
    await this.knex('refresh_tokens')
      .where('id', storedToken.id)
      .update({ revoked: true });

    // Generate new tokens
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
