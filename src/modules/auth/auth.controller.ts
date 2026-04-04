import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Get,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard, CurrentUser } from '@/common';
import { SendOtpDto, VerifyOtpDto, ClerkSyncDto, RefreshTokenDto } from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /**
   * Step 1 — Request an OTP.
   * Works for both new users (registration) and existing users (login).
   * Optionally accepts a niche_id if the user selected one on the guest screen.
   *
   * POST /api/v1/auth/otp/send
   */
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto);
  }

  /**
   * Step 2 — Verify the OTP.
   * Creates the account (if new) or logs in (if existing), saves the niche,
   * and returns our JWT pair.
   *
   * POST /api/v1/auth/otp/verify
   */
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  /**
   * Clerk OAuth sync — exchange a Clerk session token for our own JWT pair.
   * Call this after the user completes OAuth on the frontend via Clerk.
   *
   * POST /api/v1/auth/clerk/sync
   */
  @Post('clerk/sync')
  @HttpCode(HttpStatus.OK)
  async clerkSync(@Body() dto: ClerkSyncDto) {
    return this.authService.clerkSync(dto);
  }

  /**
   * Refresh the access token using a valid refresh token.
   *
   * POST /api/v1/auth/refresh
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto);
  }

  /**
   * Revoke the current refresh token (logout).
   *
   * POST /api/v1/auth/logout
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser('id') userId: string,
    @Body('refreshToken') refreshToken: string,
  ) {
    return this.authService.logout(userId, refreshToken);
  }

  /**
   * Return the currently authenticated user's profile.
   *
   * GET /api/v1/auth/profile
   */
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async profile(@CurrentUser() user: any) {
    return user;
  }
}
