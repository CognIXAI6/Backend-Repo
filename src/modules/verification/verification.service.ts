import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UploadService, UploadFolder } from '@/modules/upload/upload.service';
import {
  CreateHealthcareVerificationDto,
  CreateLegalVerificationDto,
} from './dto/verification.dto';

export type VerificationStatus = 'pending' | 'approved' | 'rejected';

export interface ProfessionalVerification {
  id: string;
  user_id: string;
  field_id: string;
  full_name: string;
  country: string;
  state_province: string | null;
  specialty: string | null;
  license_type: string | null;
  years_of_experience: number | null;
  license_document_url: string | null;
  status: VerificationStatus;
  rejection_reason: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class VerificationService {
  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private uploadService: UploadService,
  ) {}

async createHealthcareVerification(
    userId: string,
    fieldId: string,
    dto: CreateHealthcareVerificationDto,
    file?: Express.Multer.File,
  ): Promise<ProfessionalVerification> {
    // CRITICAL DEBUG: Log the complete file object
    console.log('FILE OBJECT KEYS:', Object.keys(file || {}));
    console.log('FILE DETAILS:', {
      fieldname: file?.fieldname,
      originalname: file?.originalname,
      encoding: file?.encoding,
      mimetype: file?.mimetype,
      size: file?.size,
      hasBuffer: !!file?.buffer,
      bufferType: file?.buffer ? file.buffer.constructor.name : 'none',
      bufferLength: file?.buffer?.length,
      destination: file?.destination,
      filename: file?.filename,
      path: file?.path,
    });

    // Check if file.buffer exists and is valid
    if (file && !file.buffer) {
      console.log('WARNING: File has no buffer!');
      // If using disk storage, you might need to read from path
      if (file.path) {
        const fs = require('fs');
        file.buffer = fs.readFileSync(file.path);
        console.log('Read file from path, new buffer length:', file.buffer.length);
      }
    }

    // Check if verification already exists
    const existing = await this.knex('professional_verifications')
      .where('user_id', userId)
      .andWhere('field_id', fieldId)
      .first();

    if (existing && existing.status === 'pending') {
      throw new BadRequestException('Verification already pending');
    }

    let licenseDocumentUrl = dto.licenseDocumentUrl;

    if (file) {
      console.log('Attempting to upload file...');
      try {
        const uploadResult = await this.uploadService.uploadFile(
          file,
          UploadFolder.LICENSES,
        );
        console.log('Upload successful:', uploadResult.secure_url);
        licenseDocumentUrl = uploadResult.secure_url;
      } catch (uploadError) {
        console.error('Upload failed in service:', uploadError);
        throw uploadError;
      }
    }

    const [verification] = await this.knex('professional_verifications')
      .insert({
        user_id: userId,
        field_id: fieldId,
        full_name: dto.fullName,
        country: dto.country,
        specialty: dto.specialty,
        years_of_experience: dto.yearsOfExperience,
        license_type: dto.licenseType,
        license_document_url: licenseDocumentUrl,
        status: 'approved',
      })
      .returning('*');

    return verification;
  }

  
  async createLegalVerification(
    userId: string,
    fieldId: string,
    dto: CreateLegalVerificationDto,
    file?: Express.Multer.File,
  ): Promise<ProfessionalVerification> {
    const existing = await this.knex('professional_verifications')
      .where('user_id', userId)
      .andWhere('field_id', fieldId)
      .first();

    if (existing && existing.status === 'pending') {
      throw new BadRequestException('Verification already pending');
    }

    let licenseDocumentUrl = dto.licenseDocumentUrl;

    if (file) {
      const uploadResult = await this.uploadService.uploadFile(
        file,
        UploadFolder.LICENSES,
      );
      licenseDocumentUrl = uploadResult.secure_url;
    }

    const [verification] = await this.knex('professional_verifications')
      .insert({
        user_id: userId,
        field_id: fieldId,
        full_name: dto.fullName,
        country: dto.country,
        state_province: dto.stateProvince,
        specialty: dto.practiceType,
        license_document_url: licenseDocumentUrl,
        status: 'approved',
      })
      .returning('*');

    return verification;
  }

  async getUserVerifications(userId: string): Promise<ProfessionalVerification[]> {
    return this.knex('professional_verifications')
      .select('professional_verifications.*', 'fields.name as field_name')
      .join('fields', 'professional_verifications.field_id', 'fields.id')
      .where('professional_verifications.user_id', userId);
  }

  async getVerificationStatus(userId: string, fieldId: string): Promise<ProfessionalVerification | null> {
    return this.knex('professional_verifications')
      .where('user_id', userId)
      .andWhere('field_id', fieldId)
      .first();
  }

  async isUserVerifiedForField(userId: string, fieldId: string): Promise<boolean> {
    const verification = await this.getVerificationStatus(userId, fieldId);
    return verification?.status === 'approved';
  }

  // Admin methods
  async approveVerification(verificationId: string): Promise<ProfessionalVerification> {
    const [verification] = await this.knex('professional_verifications')
      .where('id', verificationId)
      .update({
        status: 'approved',
        reviewed_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');

    if (!verification) {
      throw new NotFoundException('Verification not found');
    }

    return verification;
  }

  async rejectVerification(
    verificationId: string,
    reason: string,
  ): Promise<ProfessionalVerification> {
    const [verification] = await this.knex('professional_verifications')
      .where('id', verificationId)
      .update({
        status: 'rejected',
        rejection_reason: reason,
        reviewed_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');

    if (!verification) {
      throw new NotFoundException('Verification not found');
    }

    return verification;
  }
}
