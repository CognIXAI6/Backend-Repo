import { Injectable, Inject, BadRequestException } from "@nestjs/common";
import { Knex } from "knex";
import { KNEX_CONNECTION } from "@/database/database.module";
import { UsersService } from "@/modules/users/users.service";
import { FieldsService } from "@/modules/fields/fields.service";
import { SpeakersService } from "@/modules/speakers/speakers.service";
import { VoiceSample, VoiceService } from "@/modules/voice/voice.service";
import { VerificationService } from "@/modules/verification/verification.service";
import { UploadFolder, UploadService } from "../upload/upload.service";

export interface OnboardingStatus {
  currentStep: number;
  totalSteps: number;
  steps: {
    name: boolean;
    field: boolean;
    verification: boolean | "not_required";
    speakers: boolean;
    voice: boolean | "skipped";
  };
  isComplete: boolean;
  requiresVerification: boolean;
  verificationStatus?: "pending" | "approved" | "rejected" | null;
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
    private uploadService: UploadService,
  ) {}

  async getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const primaryField = await this.fieldsService.getUserPrimaryField(userId);
    const speakers = await this.speakersService.getUserSpeakers(userId);
    const hasVoiceSample = await this.voiceService.hasVoiceSample(userId);

    let verificationStatus: "pending" | "approved" | "rejected" | null = null;
    let requiresVerification = false;

    // if (primaryField?.requires_verification) {
    //   requiresVerification = true;
    //   const verification = await this.verificationService.getVerificationStatus(
    //     userId,
    //     primaryField.id,
    //   );
    //   console.log("Verification Status:", verification);
    //   verificationStatus = verification?.status || null;
    // }

    const steps = {
      name: !!user.name,
      field: !!primaryField,
      verification: requiresVerification
        ? verificationStatus === "approved"
        : ("not_required" as const),
      speakers: speakers.length > 0,
      voice: hasVoiceSample || ("skipped" as const), // Voice is optional
    };

    // Calculate current step
    let currentStep = 1;
    if (steps.name) currentStep = 2;
    if (steps.field) currentStep = 3;
    if (steps.verification === true || steps.verification === "not_required")
      currentStep = 4;
    if (steps.speakers) currentStep = 5;

    const isComplete =
      steps.name &&
      steps.field &&
      (steps.verification === true || steps.verification === "not_required") &&
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
      onboarding_status: "in_progress",
    });

    // Create owner speaker with user's name
    await this.speakersService.createOwnerSpeaker(userId, name);

    return { message: "Name set successfully" };
  }

  async selectField(userId: string, fieldId: string) {
    const field = await this.fieldsService.findById(fieldId);
    const custom_field = await this.fieldsService.getUserCustomFieldById(
      userId,
      fieldId,
    );

    if (!field && !custom_field) {
      throw new BadRequestException("Invalid field");
    }

    const isCustom = !field && !!custom_field;

    await this.fieldsService.assignFieldToUser(userId, fieldId, true, isCustom);

    if (field?.is_free) {
      await this.usersService.update(userId, { subscription_tier: "free" });
    }

    return {
      message: "Field selected",
      requiresVerification: field?.requires_verification,
      fieldName: field?.name ?? custom_field?.name,
    };
  }

  async setSpeakerMode(
    userId: string,
    mode: string,
    additionalSpeakers?: string[],
  ) {
    // Mode can be: 'single', 'listener', 'two', 'multiple'
    // additionalSpeakers is an array of speaker names

    if (additionalSpeakers && additionalSpeakers.length > 0) {
      for (const name of additionalSpeakers) {
        await this.speakersService.createSpeaker(userId, name);
      }
    }

    return {
      message: "Speaker mode configured",
      speakers: await this.speakersService.getUserSpeakers(userId),
    };
  }

  async completeOnboarding(userId: string) {
    const status = await this.getOnboardingStatus(userId);

    if (!status.isComplete) {
      throw new BadRequestException(
        "Please complete all required onboarding steps",
      );
    }

    await this.usersService.update(userId, { onboarding_status: "completed" });

    return { message: "Onboarding completed", status };
  }

  async voiceSample(userId: string) {
    // Voice sample is optional, so we just acknowledge the skip
    return { message: "Voice sample skipped" };
  }

  async handleVoiceSample(
    userId: string,
    file?: Express.Multer.File,
    durationSeconds?: number,
    speakerId?: string,
    skip: boolean = false,
  ): Promise<{
    message: string;
    voiceSample?: VoiceSample;
    skipped?: boolean;
  }> {
    // If user wants to skip
    if (skip || !file) {
      await this.knex("users").where({ id: userId }).update({
        voice_sample_skipped: true,
        voice_sample_completed_at: new Date(),
      });

      return {
        message: "Voice sample step completed (skipped)",
        skipped: true,
      };
    }

    // If file is provided, upload and save
    if (!durationSeconds) {
      throw new BadRequestException(
        "Duration is required when uploading voice sample",
      );
    }

    // Validate duration (10-20 seconds)
    if (durationSeconds < 10 || durationSeconds > 20) {
      throw new BadRequestException(
        "Voice sample must be between 10-20 seconds",
      );
    }

    // Upload to cloud storage
    const uploadResult = await this.uploadService.uploadFile(
      file,
      UploadFolder.VOICE_SAMPLES,
      "video", // Audio files use 'video' resource type in Cloudinary
    );

    // Save to database
    const [voiceSample] = await this.knex("voice_samples")
      .insert({
        user_id: userId,
        speaker_id: speakerId || null,
        audio_url: uploadResult.secure_url,
        cloudinary_public_id: uploadResult.public_id,
        duration_seconds: durationSeconds,
        file_size: file.size,
        mime_type: file.mimetype,
        original_filename: file.originalname,
        created_at: new Date(),
      })
      .returning("*");

    // Update onboarding status
    await this.knex("users").where({ id: userId }).update({
      onboarding_status: "completed",
      voice_sample_skipped: false,
      voice_sample_completed_at: new Date(),
      updated_at: new Date(),
    });

    return {
      message: "Voice sample uploaded successfully",
      voiceSample,
    };
  }
}
