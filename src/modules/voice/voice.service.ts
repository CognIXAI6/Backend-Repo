import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UploadService, UploadFolder } from '@/modules/upload/upload.service';

export interface VoiceSample {
  id: string;
  user_id: string;
  speaker_id: string | null;
  audio_url: string;
  duration_seconds: number;
  voice_profile: Record<string, any> | null;
  created_at: Date;
}

@Injectable()
export class VoiceService {
  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private uploadService: UploadService,
  ) {}

  async uploadVoiceSample(
    userId: string,
    file: Express.Multer.File,
    durationSeconds: number,
    speakerId?: string,
  ): Promise<VoiceSample> {
    if (!file) {
      throw new BadRequestException('No audio file provided');
    }

    // Validate duration (10-15 seconds as per requirement)
    if (durationSeconds < 10 || durationSeconds > 20) {
      throw new BadRequestException('Voice sample must be between 10-15 seconds');
    }

    const uploadResult = await this.uploadService.uploadFile(
      file,
      UploadFolder.VOICE_SAMPLES,
      'video', // Audio files in Cloudinary use 'video' resource type
    );

    const [voiceSample] = await this.knex('voice_samples')
      .insert({
        user_id: userId,
        speaker_id: speakerId,
        audio_url: uploadResult.secure_url,
        duration_seconds: durationSeconds,
      })
      .returning('*');

    return voiceSample;
  }

  async uploadVoiceSampleBase64(
    userId: string,
    base64Audio: string,
    durationSeconds: number,
    speakerId?: string,
  ): Promise<VoiceSample> {
    if (durationSeconds < 10 || durationSeconds > 20) {
      throw new BadRequestException('Voice sample must be between 10-15 seconds');
    }

    const uploadResult = await this.uploadService.uploadBase64(
      base64Audio,
      UploadFolder.VOICE_SAMPLES,
      'video',
    );

    const [voiceSample] = await this.knex('voice_samples')
      .insert({
        user_id: userId,
        speaker_id: speakerId,
        audio_url: uploadResult.secure_url,
        duration_seconds: durationSeconds,
      })
      .returning('*');

    return voiceSample;
  }

  async getUserVoiceSamples(userId: string): Promise<VoiceSample[]> {
    return this.knex('voice_samples')
      .where('user_id', userId)
      .orderBy('created_at', 'desc');
  }

  async getVoiceSampleBySpeaker(
    userId: string,
    speakerId: string,
  ): Promise<VoiceSample | null> {
    return this.knex('voice_samples')
      .where('user_id', userId)
      .andWhere('speaker_id', speakerId)
      .first();
  }

  async hasVoiceSample(userId: string): Promise<boolean> {
    const sample = await this.knex('voice_samples')
      .where('user_id', userId)
      .first();

    return !!sample;
  }

  async updateVoiceProfile(
    voiceSampleId: string,
    voiceProfile: Record<string, any>,
  ): Promise<VoiceSample> {
    const [updated] = await this.knex('voice_samples')
      .where('id', voiceSampleId)
      .update({ voice_profile: voiceProfile })
      .returning('*');

    return updated;
  }

  async deleteVoiceSample(userId: string, voiceSampleId: string): Promise<void> {
    await this.knex('voice_samples')
      .where('id', voiceSampleId)
      .andWhere('user_id', userId)
      .delete();
  }
}
