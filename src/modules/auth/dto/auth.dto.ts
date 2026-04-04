import { IsEmail, IsString, IsOptional, Length, IsUUID } from 'class-validator';

/**
 * Step 1 of OTP registration/login: send OTP to email.
 * niche_id is optional — guest may have selected it before hitting the limit.
 */
export class SendOtpDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsUUID()
  niche_id?: string;
}

/**
 * Step 2 of OTP registration/login: verify code.
 * niche_id is optional — can be provided here if not sent in step 1.
 */
export class VerifyOtpDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6)
  otp: string;

  @IsOptional()
  @IsUUID()
  niche_id?: string;
}

/**
 * Clerk OAuth sync: exchange a Clerk session token for our own JWT.
 * The frontend authenticates with Clerk then calls this endpoint.
 */
export class ClerkSyncDto {
  @IsString()
  clerkToken: string;

  @IsOptional()
  @IsUUID()
  niche_id?: string;
}

export class RefreshTokenDto {
  @IsString()
  refreshToken: string;
}
