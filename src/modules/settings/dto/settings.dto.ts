import { IsString, IsOptional, IsEnum, IsObject } from 'class-validator';

export enum ResponseLength {
  CONCISE = 'concise',
  BALANCED = 'balanced',
  DETAILED = 'detailed',
}

export enum Tone {
  PROFESSIONAL = 'professional',
  FRIENDLY = 'friendly',
  DIRECT = 'direct',
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;
}

export class UpdateAiPreferencesDto {
  @IsOptional()
  @IsEnum(ResponseLength)
  responseLength?: ResponseLength;

  @IsOptional()
  @IsEnum(Tone)
  tone?: Tone;

  @IsOptional()
  @IsString()
  language?: string;

  // @IsOptional()
  // @IsObject()
  // customInstructions?: Record<string, any>;
}