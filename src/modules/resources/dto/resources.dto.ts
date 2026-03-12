import { Transform } from 'class-transformer';
import { IsString, IsOptional, IsEnum, IsArray, IsUrl, IsUUID, IsNotEmpty } from 'class-validator';

export enum ResourceType {
  TEXTBOOK = 'textbook',
  VIDEO = 'video',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  LINK = 'link',
  IMAGE = 'image',
}

// export class CreateResourceDto {
//   @IsEnum(ResourceType)
//   type: ResourceType;

//   @IsString()
//   title: string;

//   @IsOptional()
//   @IsString()
//   description?: string;

//   @IsOptional()
//   @IsUUID()
//   fieldId?: string;

//   @IsOptional()
//   // @IsUrl()
//   externalUrl?: string;

//   @IsOptional()
//   @IsArray()
//   @IsString({ each: true })
//   tags?: string[];
// }

export class CreateResourceDto {
  @IsUUID()
  @IsOptional()
  fieldId?: string;

  @IsEnum(ResourceType)
  type: ResourceType;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
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
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}

export class UpdateResourceDto {
  @IsOptional()
  @IsString()
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
  page?: number;

  @IsOptional()
  limit?: number;
}