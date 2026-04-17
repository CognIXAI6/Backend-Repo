import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UsersService } from '@/modules/users/users.service';
import { FieldsService } from '@/modules/fields/fields.service';
import { SpeakersService } from '@/modules/speakers/speakers.service';
import { VoiceSample } from '@/modules/voice/services/voice.service';
import { UploadFolder, UploadService } from '../upload/upload.service';

export interface OnboardingStatus {
  currentStep: number;
  totalSteps: number;
  steps: {
    /** Professional niche / field selected */
    niche: boolean;
    /** Display name set (optional — does not block completion) */
    name: boolean;
  };
  /** true once niche is selected — name and voice are optional */
  isComplete: boolean;
}

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private usersService: UsersService,
    private fieldsService: FieldsService,
    private speakersService: SpeakersService,
    private uploadService: UploadService,
  ) {}

  // ─── Status ────────────────────────────────────────────────────────────────

  async getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
    const user = await this.usersService.findById(userId);
    if (!user) throw new BadRequestException('User not found');

    const primaryField = await this.fieldsService.getUserPrimaryField(userId);

    const steps = {
      niche: !!primaryField,
      name: !!user.name,
    };

    // currentStep: 1 = no niche yet, 2 = niche done (name optional prompt), 3 = all done
    let currentStep = 1;
    if (steps.niche) currentStep = steps.name ? 3 : 2;

    // Onboarding is complete as soon as the niche is selected
    const isComplete = steps.niche;

    // Sync DB status if it's out of sync
    if (isComplete && user.onboarding_status !== 'completed') {
      await this.usersService.update(userId, { onboarding_status: 'completed' });
    }

    return { currentStep, totalSteps: 2, steps, isComplete };
  }

  // ─── Set name ──────────────────────────────────────────────────────────────

  async setName(userId: string, name: string) {
    if (!name?.trim()) throw new BadRequestException('Name cannot be empty');

    await this.usersService.update(userId, { name: name.trim() });

    // Keep the owner speaker in sync with the display name
    const speakers = await this.speakersService.getUserSpeakers(userId);
    const ownerSpeaker = speakers.find((s: any) => s.is_owner);
    if (!ownerSpeaker) {
      await this.speakersService.createOwnerSpeaker(userId, name.trim());
    }

    return { message: 'Name updated' };
  }

  // ─── Select niche ──────────────────────────────────────────────────────────

  async selectNiche(userId: string, fieldId: string) {
    const field = await this.fieldsService.findById(fieldId);
    const customField = await this.fieldsService.getUserCustomFieldById(userId, fieldId);

    if (!field && !customField) throw new BadRequestException('Invalid niche');

    const isCustom = !field && !!customField;
    await this.fieldsService.assignFieldToUser(userId, fieldId, true, isCustom);

    // Mark onboarding as completed the moment a niche is selected
    await this.usersService.update(userId, { onboarding_status: 'completed' });

    return {
      message: 'Niche selected',
      fieldName: field?.name ?? customField?.name,
    };
  }

  // ─── Complete onboarding ───────────────────────────────────────────────────

  async completeOnboarding(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new BadRequestException('User not found');

    await this.usersService.update(userId, { onboarding_status: 'completed' });

    return { message: 'Onboarding completed', isComplete: true };
  }

  // ─── Voice sample (optional feature, not an onboarding gate) ───────────────

  async handleVoiceSample(
    userId: string,
    file?: Express.Multer.File,
    durationSeconds?: number,
    speakerId?: string,
    skip = false,
  ): Promise<{ message: string; voiceSample?: VoiceSample; skipped?: boolean }> {
    if (skip || !file) {
      await this.knex('users').where({ id: userId }).update({
        voice_sample_skipped: true,
        voice_sample_completed_at: new Date(),
      });
      return { message: 'Voice sample step skipped', skipped: true };
    }

    if (!durationSeconds) {
      throw new BadRequestException('durationSeconds is required when uploading a voice sample');
    }
    if (durationSeconds < 10 || durationSeconds > 20) {
      throw new BadRequestException('Voice sample must be between 10 and 20 seconds');
    }

    const uploadResult = await this.uploadService.uploadFile(
      file,
      UploadFolder.VOICE_SAMPLES,
      'video', // Cloudinary uses 'video' resource type for audio
    );

    const [voiceSample] = await this.knex('voice_samples')
      .insert({
        user_id: userId,
        speaker_id: speakerId ?? null,
        audio_url: uploadResult.secure_url,
        cloudinary_public_id: uploadResult.public_id,
        duration_seconds: durationSeconds,
        file_size: file.size,
        mime_type: file.mimetype,
        original_filename: file.originalname,
        created_at: new Date(),
      })
      .returning('*');

    await this.knex('users').where({ id: userId }).update({
      voice_sample_skipped: false,
      voice_sample_completed_at: new Date(),
      updated_at: new Date(),
    });

    return { message: 'Voice sample uploaded', voiceSample };
  }
}
