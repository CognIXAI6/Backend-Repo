import { IsString, IsOptional, IsInt, Min } from 'class-validator';

import { Transform } from 'class-transformer';

export class CreateHealthcareVerificationDto {
  @IsString()
  fullName: string;

  @IsString()
  country: string;

  @IsString()
  specialty: string;

  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(0)
  yearsOfExperience: number;

  @IsString()
  licenseType: string;

  @IsString()
  fieldId: string;  // Move fieldId here

  @IsOptional()
  @IsString()
  licenseDocumentUrl?: string;
}


export class CreateLegalVerificationDto {
  @IsString()
  fullName: string;

  @IsString()
  country: string;

  @IsString()
  stateProvince: string;

  @IsString()
  practiceType: string;

  @IsString()
  fieldId: string;

  @IsOptional()
  @IsString()
  licenseDocumentUrl?: string;
}
