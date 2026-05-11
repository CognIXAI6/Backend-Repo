import { Transform, Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsUrl,
  IsUUID,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
} from 'class-validator';

export enum ResourceType {
  TEXTBOOK = 'textbook',
  VIDEO = 'video',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  LINK = 'link',
  IMAGE = 'image',
}

export class CreateResourceDto {
  @IsOptional()
  // @IsUUID()
  fieldId?: string;

  @IsEnum(ResourceType)
  type: ResourceType;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUrl({}, { message: 'externalUrl must be a valid URL' })
  externalUrl?: string;

  @Transform(({ value }) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [value];
    }
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateResourceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  fieldId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class ResourceQueryDto {
  @IsOptional()
  @IsEnum(ResourceType)
  type?: ResourceType;

  @IsOptional()
  @IsUUID()
  fieldId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
