import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { verifyToken as verifyClerkToken } from '@clerk/backend';
import { createClerkClient } from '@clerk/backend';
import { UsersService } from '@/modules/users/users.service';
import { Request } from 'express';

/**
 * Passport strategy that validates a Clerk session token sent as a Bearer token.
 *
 * This strategy is used when the frontend authenticates via Clerk OAuth and forwards
 * the Clerk-issued token to our API.  We verify it with the Clerk SDK, resolve the
 * matching user in our own database, and attach a normalised user object to the
 * request — identical in shape to what JwtStrategy produces — so all guards and
 * decorators work transparently.
 */
@Injectable()
export class ClerkJwtStrategy extends PassportStrategy(Strategy, 'clerk-jwt') {
  private clerkSecretKey: string | undefined;
  private clerkClient: ReturnType<typeof createClerkClient> | null = null;

  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      // Clerk tokens are standard JWTs — use the same bearer extractor.
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // passport-jwt needs a secretOrKey but we re-verify via Clerk SDK in validate().
      secretOrKey: 'clerk-bypass-placeholder',
      passReqToCallback: true,
    });

    this.clerkSecretKey = this.configService.get<string>('clerk.secretKey');
    if (this.clerkSecretKey) {
      this.clerkClient = createClerkClient({ secretKey: this.clerkSecretKey });
    }
  }

  async validate(req: Request) {
    if (!this.clerkSecretKey) {
      throw new UnauthorizedException('Clerk integration is not configured');
    }

    const authHeader = req.headers['authorization'] ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');

    let payload: { sub: string };
    try {
      payload = await verifyClerkToken(token, { secretKey: this.clerkSecretKey }) as { sub: string };
    } catch {
      throw new UnauthorizedException('Invalid Clerk session token');
    }

    const user = await this.usersService.findByClerkId(payload.sub);
    if (!user) {
      throw new UnauthorizedException('No local account linked to this Clerk identity. Please sync first.');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.email_verified,
      onboardingStatus: user.onboarding_status,
      subscriptionTier: user.subscription_tier,
      stripeCustomerId: user.stripe_customer_id,
      avatar: user.avatar_url,
      authProvider: user.auth_provider,
    };
  }
}
