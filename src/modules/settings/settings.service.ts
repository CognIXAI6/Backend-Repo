import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UploadService, UploadFolder } from '@/modules/upload/upload.service';
import { UpdateProfileDto, UpdateAiPreferencesDto } from './dto/settings.dto';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private uploadService: UploadService,
  ) {}

  // ============ PROFILE ============

  async getProfile(userId: string) {
    const user = await this.knex('users')
      .select('id', 'email', 'name', 'avatar_url', 'created_at')
      .where('id', userId)
      .first();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const updateData: Record<string, any> = { updated_at: new Date() };

    if (dto.name !== undefined) {
      updateData.name = dto.name;
    }

    if (dto.avatarUrl !== undefined) {
      updateData.avatar_url = dto.avatarUrl;
    }

    const [user] = await this.knex('users')
      .where('id', userId)
      .update(updateData)
      .returning(['id', 'email', 'name', 'avatar_url', 'created_at']);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    };
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    const uploadResult = await this.uploadService.uploadFile(
      file,
      UploadFolder.AVATARS,
      'image',
    );

    const [user] = await this.knex('users')
      .where('id', userId)
      .update({
        avatar_url: uploadResult.secure_url,
        updated_at: new Date(),
      })
      .returning(['id', 'email', 'name', 'avatar_url']);

    return {
      avatarUrl: user.avatar_url,
      message: 'Avatar uploaded successfully',
    };
  }

  async removeAvatar(userId: string) {
    await this.knex('users')
      .where('id', userId)
      .update({
        avatar_url: null,
        updated_at: new Date(),
      });

    return { message: 'Avatar removed successfully' };
  }

  // ============ AI PREFERENCES ============

  async getAiPreferences(userId: string) {
    let preferences = await this.knex('user_preferences')
      .where('user_id', userId)
      .first();

    // Create default preferences if not exists
    if (!preferences) {
      [preferences] = await this.knex('user_preferences')
        .insert({
          user_id: userId,
          response_length: 'balanced',
          tone: 'professional',
          language: 'en',
        })
        .returning('*');
    }

    return {
      responseLength: preferences.response_length,
      tone: preferences.tone,
      language: preferences.language,
      customInstructions: preferences.custom_instructions,
    };
  }

  async updateAiPreferences(userId: string, dto: UpdateAiPreferencesDto) {
    const existing = await this.knex('user_preferences')
      .where('user_id', userId)
      .first();

    const updateData: Record<string, any> = { updated_at: new Date() };

    if (dto.responseLength !== undefined) {
      updateData.response_length = dto.responseLength;
    }
    if (dto.tone !== undefined) {
      updateData.tone = dto.tone;
    }
    if (dto.language !== undefined) {
      updateData.language = dto.language;
    }
    // if (dto.customInstructions !== undefined) {
    //   updateData.custom_instructions = dto.customInstructions;
    // }

    let preferences;

    if (existing) {
      [preferences] = await this.knex('user_preferences')
        .where('user_id', userId)
        .update(updateData)
        .returning('*');
    } else {
      [preferences] = await this.knex('user_preferences')
        .insert({
          user_id: userId,
          ...updateData,
        })
        .returning('*');
    }

    return {
      responseLength: preferences.response_length,
      tone: preferences.tone,
      language: preferences.language,
      customInstructions: preferences.custom_instructions,
    };
  }

  // Get AI prompt context based on user preferences
//   async getAiPromptContext(userId: string) {
//     const preferences = await this.getAiPreferences(userId);

//     const responseLengthMap = {
//       concise: 'Provide short, direct answers without unnecessary elaboration.',
//       balanced: 'Provide clear explanations without too much detail.',
//       detailed: 'Provide in-depth reasoning and step-by-step explanations.',
//     };

//     const toneMap = {
//       professional: 'Use a clear, neutral, and work-focused tone.',
//       friendly: 'Use a warm and conversational tone.',
//       direct: 'Be straight to the point with minimal pleasantries.',
//     };

//     return {
//       responseLength: responseLengthMap[preferences.responseLength] || responseLengthMap.balanced,
//       tone: toneMap[preferences.tone] || toneMap.professional,
//       language: preferences.language,
//       customInstructions: preferences.customInstructions,
//     };
//   }
}