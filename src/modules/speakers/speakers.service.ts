import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UploadFolder, UploadService } from '../upload/upload.service';

export interface Speaker {
  id: string;
  user_id: string;
  name: string;
  avatar_url: string | null;
  is_owner: boolean;
  created_at: Date;
}

@Injectable()
export class SpeakersService {
  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private uploadService: UploadService,
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

  async getSpeakerModes() {
    const setting = await this.knex('app_settings').where('key', 'speaker_modes').first();
    return setting?.value;
  }
}
