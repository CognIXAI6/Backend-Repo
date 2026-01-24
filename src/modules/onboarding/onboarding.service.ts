import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UsersService } from '@/modules/users/users.service';
import { FieldsService } from '@/modules/fields/fields.service';
import { SpeakersService } from '@/modules/speakers/speakers.service';
import { VoiceService } from '@/modules/voice/voice.service';
import { VerificationService } from '@/modules/verification/verification.service';

export interface OnboardingStatus {
  currentStep: number;
  totalSteps: number;
  steps: {
    name: boolean;
    field: boolean;
    verification: boolean | 'not_required';
    speakers: boolean;
    voice: boolean | 'skipped';
  };
  isComplete: boolean;
  requiresVerification: boolean;
  verificationStatus?: 'pending' | 'approved' | 'rejected' | null;
}

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private usersService: UsersService,
    private fieldsService: FieldsService,
    private speakersService: SpeakersService,
    private voiceService: VoiceService,
    private verificationService: VerificationService,
  ) {}

  async getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const primaryField = await this.fieldsService.getUserPrimaryField(userId);
    const speakers = await this.speakersService.getUserSpeakers(userId);
    const hasVoiceSample = await this.voiceService.hasVoiceSample(userId);

    let verificationStatus: 'pending' | 'approved' | 'rejected' | null = null;
    let requiresVerification = false;

    if (primaryField?.requires_verification) {
      requiresVerification = true;
      const verification = await this.verificationService.getVerificationStatus(
        userId,
        primaryField.id,
      );
      verificationStatus = verification?.status || null;
    }

    const steps = {
      name: !!user.name,
      field: !!primaryField,
      verification: requiresVerification
        ? verificationStatus === 'approved'
        : ('not_required' as const),
      speakers: speakers.length > 0,
      voice: hasVoiceSample || ('skipped' as const), // Voice is optional
    };

    // Calculate current step
    let currentStep = 1;
    if (steps.name) currentStep = 2;
    if (steps.field) currentStep = 3;
    if (steps.verification === true || steps.verification === 'not_required') currentStep = 4;
    if (steps.speakers) currentStep = 5;

    const isComplete =
      steps.name &&
      steps.field &&
      (steps.verification === true || steps.verification === 'not_required') &&
      steps.speakers;

    return {
      currentStep,
      totalSteps: 4, // Name, Field, Speakers, Voice (verification is conditional)
      steps,
      isComplete,
      requiresVerification,
      verificationStatus,
    };
  }

  async setName(userId: string, name: string) {
    await this.usersService.update(userId, {
      name,
      onboarding_status: 'in_progress',
    });

    // Create owner speaker with user's name
    await this.speakersService.createOwnerSpeaker(userId, name);

    return { message: 'Name set successfully' };
  }

  async selectField(userId: string, fieldId: string) {
    const field = await this.fieldsService.findById(fieldId);
    if (!field) {
      throw new BadRequestException('Invalid field');
    }

    await this.fieldsService.assignFieldToUser(userId, fieldId, true);

    // If field is free (General Knowledge), user can use for free
    if (field.is_free) {
      await this.usersService.update(userId, { subscription_tier: 'free' });
    }

    return {
      message: 'Field selected',
      requiresVerification: field.requires_verification,
      fieldName: field.name,
    };
  }

  async setSpeakerMode(userId: string, mode: string, additionalSpeakers?: string[]) {
    // Mode can be: 'single', 'listener', 'two', 'multiple'
    // additionalSpeakers is an array of speaker names

    if (additionalSpeakers && additionalSpeakers.length > 0) {
      for (const name of additionalSpeakers) {
        await this.speakersService.createSpeaker(userId, name);
      }
    }

    return {
      message: 'Speaker mode configured',
      speakers: await this.speakersService.getUserSpeakers(userId),
    };
  }

  async completeOnboarding(userId: string) {
    const status = await this.getOnboardingStatus(userId);

    if (!status.isComplete) {
      throw new BadRequestException('Please complete all required onboarding steps');
    }

    await this.usersService.update(userId, { onboarding_status: 'completed' });

    return { message: 'Onboarding completed', status };
  }

  async skipVoiceSample(userId: string) {
    // Voice sample is optional, so we just acknowledge the skip
    return { message: 'Voice sample skipped' };
  }
}
