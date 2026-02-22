import { IsEmail, IsString, MinLength, IsOptional, Length, IsNumberString, Matches } from 'class-validator';

export class SignupDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/,
    {
      message: 
        'Password must contain at least one lowercase letter, one uppercase letter, one number, and one special character (@$!%*#?&)',
    }
  )
  password: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/,
    {
      message: 
        'Password must contain at least one lowercase letter, one uppercase letter, one number, and one special character (@$!%*#?&)',
    }
  )
  password: string;
}

export class VerifyEmailDto {
  @IsString()
  token: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

export class VerifyOtpDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6)
  otp: string;
}

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6)
  otp: string;

  @IsString()
  @MinLength(8)
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/,
    {
      message: 
        'Password must contain at least one lowercase letter, one uppercase letter, one number, and one special character (@$!%*#?&)',
    }
  )
  password: string;
}

export class RefreshTokenDto {
  @IsString()
  refreshToken: string;
}
