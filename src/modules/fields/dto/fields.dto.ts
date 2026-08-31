import { IsString, IsOptional, IsBoolean, IsNotEmpty, MaxLength } from 'class-validator';

export class CreateFieldDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  /** Defaults to a slugified version of `name` when omitted. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  requiresVerification?: boolean;

  /** Defaults to true — fields created through this admin endpoint are the curated default catalog. */
  @IsOptional()
  @IsBoolean()
  isSystem?: boolean;

  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateFieldDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  /** Only changed when explicitly provided — a name-only update never rewrites the slug. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  requiresVerification?: boolean;

  @IsOptional()
  @IsBoolean()
  isSystem?: boolean;

  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
