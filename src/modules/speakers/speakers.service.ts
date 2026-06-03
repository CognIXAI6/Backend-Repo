import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UploadFolder, UploadService } from '../upload/upload.service';
import { VoiceVerificationService } from '../voice/services/voice-verification.service';

export interface Speaker {
  id: string;
  user_id: string;
  name: string;
  avatar_url: string | null;
  is_owner: boolean;
  voice_speaker_id: string | null;
  voice_embedding_id: string | null;
  created_at: Date;
}

@Injectable()
export class SpeakersService {
  private readonly logger = new Logger(SpeakersService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private uploadService: UploadService,
    private voiceVerificationService: VoiceVerificationService,
  ) {}

  // async createSpeaker(
  //   userId: string,
  //   name: string,
  //   isOwner = false,
  //   avatarUrl?: string,
  // ): Promise<Speaker> {
  //   const [speaker] = await this.knex('speakers')
  //     .insert({
  //       user_id: userId,
  //       name,
  //       is_owner: isOwner,
  //       avatar_url: avatarUrl,
  //     })
  //     .returning('*');

  //   return speaker;
  // }

  async createSpeaker(
    userId: string,
    name: string,
    isOwner = false,
    file?: Express.Multer.File,
  ): Promise<Speaker> {
    // Prevent duplicate speakers with the same name for the same user
    const existing = await this.knex('speakers')
      .where('user_id', userId)
      .whereRaw('LOWER(name) = LOWER(?)', [name.trim()])
      .andWhere('is_owner', isOwner)
      .first();

    if (existing) return existing;

    let avatarUrl: string | undefined;

    if (file) {
      const uploadResult = await this.uploadService.uploadFile(
        file,
        UploadFolder.AVATARS,
        'image',
      );
      avatarUrl = uploadResult.secure_url;
    }

    const [speaker] = await this.knex('speakers')
      .insert({
        user_id: userId,
        name: name.trim(),
        is_owner: isOwner,
        avatar_url: avatarUrl ?? null,
      })
      .returning('*');

    return speaker;
  }

  async createOwnerSpeaker(userId: string, name: string): Promise<Speaker> {
    // Check if owner speaker already exists
    const existing = await this.knex('speakers')
      .where('user_id', userId)
      .andWhere('is_owner', true)
      .first();

    if (existing) {
      // Update existing
      const [updated] = await this.knex('speakers')
        .where('id', existing.id)
        .update({ name })
        .returning('*');
      return updated;
    }

    return this.createSpeaker(userId, name, true);
  }

  async getUserSpeakers(userId: string): Promise<Speaker[]> {
    return this.knex('speakers')
      .where('user_id', userId)
      .orderBy('is_owner', 'desc')
      .orderBy('created_at', 'asc');
  }

  async getSpeakerById(userId: string, speakerId: string): Promise<Speaker | null> {
    return this.knex('speakers')
      .where('id', speakerId)
      .andWhere('user_id', userId)
      .first();
  }

  // async updateSpeaker(
  //   userId: string,
  //   speakerId: string,
  //   name: string,
  //   avatarUrl?: string,
  // ): Promise<Speaker> {
  //   const speaker = await this.getSpeakerById(userId, speakerId);
  //   if (!speaker) {
  //     throw new NotFoundException('Speaker not found');
  //   }

  //   const updateData: Partial<Speaker> = { name };
  //   if (avatarUrl !== undefined) {
  //     updateData.avatar_url = avatarUrl;
  //   }

  //   const [updated] = await this.knex('speakers')
  //     .where('id', speakerId)
  //     .update(updateData)
  //     .returning('*');

  //   return updated;
  // }

  async updateSpeaker(
    userId: string,
    speakerId: string,
    name: string,
    file?: Express.Multer.File,
  ): Promise<Speaker> {
    const speaker = await this.getSpeakerById(userId, speakerId);

    if (!speaker) {
      throw new NotFoundException('Speaker not found');
    }

    const updateData: Partial<Speaker> = { name };

    if (file) {
      const uploadResult = await this.uploadService.uploadFile(
        file,
        UploadFolder.AVATARS,
        'image',
      );
      updateData.avatar_url = uploadResult.secure_url;
    }

    const [updated] = await this.knex('speakers')
      .where('id', speakerId)
      .update(updateData)
      .returning('*');

    return updated;
  }

  async deleteSpeaker(userId: string, speakerId: string): Promise<void> {
    const speaker = await this.getSpeakerById(userId, speakerId);
    if (!speaker) {
      throw new NotFoundException('Speaker not found');
    }

    if (speaker.is_owner) {
      throw new BadRequestException('Cannot delete owner speaker');
    }

    await this.knex('speakers').where('id', speakerId).delete();
  }

  async getSpeakerCount(userId: string): Promise<number> {
    const result = await this.knex('speakers')
      .where('user_id', userId)
      .count('id as count')
      .first();

    return Number(result?.count || 0);
  }

  async setVoiceProfile(
    speakerId: string,
    voiceSpeakerId: string,
    voiceEmbeddingId: string,
  ): Promise<Speaker> {
    const [updated] = await this.knex('speakers')
      .where('id', speakerId)
      .update({ voice_speaker_id: voiceSpeakerId, voice_embedding_id: voiceEmbeddingId })
      .returning('*');
    return updated;
  }

  async enrollSpeakerVoice(
    userId: string,
    speakerId: string,
    audioFile: Express.Multer.File,
  ): Promise<Speaker & { voiceEnrolled: boolean; enrollmentError?: string }> {
    const speaker = await this.getSpeakerById(userId, speakerId);
    if (!speaker) throw new NotFoundException('Speaker not found');

    // ── 1. Upload audio regardless of whether the voice service is available ─
    // This ensures the recording is always preserved and can be used for
    // re-enrollment later even if the embedding service is temporarily down.
    const uploadResult = await this.uploadService.uploadFile(
      audioFile,
      UploadFolder.VOICE_SAMPLES,
      'video',
    );

    await this.knex('voice_samples').insert({
      user_id: userId,
      speaker_id: speakerId,
      audio_url: uploadResult.secure_url,
      duration_seconds: Math.round(audioFile.size / 16000),
    });

    // ── 2. Attempt voice registration — non-fatal if service is unavailable ──
    // Common failure modes:
    //   • VOICE_VERIFICATION_URL not set (service disabled)
    //   • Python service can't resolve DNS to download its embedding model
    //   • Network partition between services
    // In all cases we return the speaker without a voice profile and let the
    // caller decide how to surface this to the user.
    if (!this.voiceVerificationService.isEnabled) {
      this.logger.warn(
        `Voice enrollment skipped for "${speaker.name}" — VOICE_VERIFICATION_URL not configured`,
      );
      return { ...speaker, voiceEnrolled: false, enrollmentError: 'Voice verification service is not configured' };
    }

    try {
      const registration = await this.voiceVerificationService.registerSpeaker(
        speaker.name,
        uploadResult.secure_url,
        speaker.voice_speaker_id ?? undefined,
      );

      const updated = await this.setVoiceProfile(
        speakerId,
        registration.speakerId,
        registration.embeddingId,
      );
      return { ...updated, voiceEnrolled: true };
    } catch (err) {
      // Log the underlying cause (DNS failure, timeout, API error…) but do NOT
      // re-throw — the speaker is already saved and the audio is in Cloudinary.
      this.logger.warn(
        `Voice registration failed for "${speaker.name}" (audio saved, no embedding): ${(err as Error).message}`,
      );
      const fresh = await this.getSpeakerById(userId, speakerId);
      return {
        ...(fresh ?? speaker),
        voiceEnrolled: false,
        enrollmentError: (err as Error).message,
      };
    }
  }

  async getSpeakerModes() {
    const setting = await this.knex('app_settings').where('key', 'speaker_modes').first();
    return setting?.value;
  }
}
