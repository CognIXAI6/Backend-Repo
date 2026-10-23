import { IsString, IsOptional, IsEnum, IsObject, ValidateIf } from 'class-validator';
import { ConversationLanguage } from '@/common/constants/conversation-languages.constant';

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

  // @IsOptional() would also let an explicit `null` through unvalidated
  // (class-validator treats null and undefined alike) — @ValidateIf keeps
  // "field omitted" skippable for partial updates while still rejecting
  // null/empty/pseudo-locale values via @IsEnum below.
  @ValidateIf((o) => o.language !== undefined)
  @IsEnum(ConversationLanguage)
  language?: ConversationLanguage;

  // @IsOptional()
  // @IsObject()
  // customInstructions?: Record<string, any>;
}