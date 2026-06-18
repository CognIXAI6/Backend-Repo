import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VoiceService } from '../services/voice.service';
import { VoiceVerificationService, SpeakerRegistrationResult, SpeakerVerificationResult } from '../services/voice-verification.service';
import { UsersService } from '@/modules/users/users.service';
import { SpeakersService } from '@/modules/speakers/speakers.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

@Controller('voice')
@UseGuards(JwtAuthGuard)
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(
    private voiceService: VoiceService,
    private voiceVerificationService: VoiceVerificationService,
    private usersService: UsersService,
    private speakersService: SpeakersService,
  ) {}

  @Get()
  async getMyVoiceSamples(@CurrentUser('id') userId: string) {
    return this.voiceService.getUserVoiceSamples(userId);
  }

  @Get('has-sample')
  async hasVoiceSample(@CurrentUser('id') userId: string) {
    const hasSample = await this.voiceService.hasVoiceSample(userId);
    return { hasSample };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('audio'))
  async uploadVoiceSample(
    @CurrentUser('id') userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('duration') duration: string,
    @Body('speakerId') speakerId?: string,
  ) {
    return this.voiceService.uploadVoiceSample(
      userId,
      file,
      parseInt(duration, 10),
      speakerId,
    );
  }

  @Post('upload-base64')
  async uploadVoiceSampleBase64(
    @CurrentUser('id') userId: string,
    @Body('audio') base64Audio: string,
    @Body('duration') duration: number,
    @Body('speakerId') speakerId?: string,
  ) {
    return this.voiceService.uploadVoiceSampleBase64(
      userId,
      base64Audio,
      duration,
      speakerId,
    );
  }

  @Delete(':id')
  async deleteVoiceSample(
    @CurrentUser('id') userId: string,
    @Param('id') voiceSampleId: string,
  ) {
    await this.voiceService.deleteVoiceSample(userId, voiceSampleId);
    return { message: 'Voice sample deleted' };
  }

  // ── Voice ID (biometric registration / verification) ───────────────────────

  /**
   * GET /voice/voice-id/status
   * Returns whether the authenticated user has registered a voice profile.
   */
  @Get('voice-id/status')
  async getVoiceIdStatus(@CurrentUser('id') userId: string) {
    const user = await this.usersService.findById(userId);
    return {
      registered: !!user?.voice_speaker_id,
      voiceSpeakerId: user?.voice_speaker_id ?? null,
    };
  }

  /**
   * POST /voice/voice-id/register
   * Registers the owner's voice with the external voice verification service.
   * Body: { audioUrl: string, speakerName?: string }
   * The audioUrl should be a Cloudinary URL (upload first via /voice/upload-base64).
   */
  @Post('voice-id/register')
  async registerOwnerVoice(
    @CurrentUser('id') userId: string,
    @Body('audioUrl') audioUrl: string,
    @Body('speakerName') speakerName?: string,
  ) {
    if (!audioUrl) throw new BadRequestException('audioUrl is required');
    if (!this.voiceVerificationService.isEnabled) {
      throw new BadRequestException('Voice verification service is not available');
    }

    const user = await this.usersService.findById(userId);
    if (!user) throw new BadRequestException('User not found');

    const name = speakerName?.trim() || user.name || user.email;

    let result: SpeakerRegistrationResult;
    try {
      result = await this.voiceVerificationService.registerSpeaker(
        name,
        audioUrl,
        user.voice_speaker_id ?? undefined,
      );
    } catch (err) {
      this.logger.error('registerOwnerVoice failed', err instanceof Error ? err.stack : err);
      throw new InternalServerErrorException('Voice registration failed. Please try again.');
    }

    await this.usersService.update(userId, {
      voice_speaker_id: result.speakerId,
      voice_embedding_id: result.embeddingId,
    });

    return {
      message: 'Voice profile registered successfully',
      voiceSpeakerId: result.speakerId,
      embeddingId: result.embeddingId,
    };
  }

  /**
   * POST /voice/voice-id/register-speaker/:speakerId
   * Registers an "other person" speaker's voice profile.
   * Body: { audioUrl: string }
   */
  @Post('voice-id/register-speaker/:speakerId')
  async registerOtherSpeakerVoice(
    @CurrentUser('id') userId: string,
    @Param('speakerId') speakerId: string,
    @Body('audioUrl') audioUrl: string,
  ) {
    if (!audioUrl) throw new BadRequestException('audioUrl is required');
    if (!this.voiceVerificationService.isEnabled) {
      throw new BadRequestException('Voice verification service is not available');
    }

    const speaker = await this.speakersService.getSpeakerById(userId, speakerId);
    if (!speaker) throw new BadRequestException('Speaker not found');

    let result: Awaited<ReturnType<typeof this.voiceVerificationService.registerSpeaker>>;
    try {
      result = await this.voiceVerificationService.registerSpeaker(
        speaker.name,
        audioUrl,
        speaker.voice_speaker_id ?? undefined,
      );
    } catch (err) {
      this.logger.error('registerOtherSpeakerVoice failed', err instanceof Error ? err.stack : err);
      throw new InternalServerErrorException('Voice registration failed. Please try again.');
    }

    await this.speakersService.setVoiceProfile(speakerId, result.speakerId, result.embeddingId);

    return {
      message: `Voice profile registered for ${speaker.name}`,
      voiceSpeakerId: result.speakerId,
      embeddingId: result.embeddingId,
    };
  }

  /**
   * POST /voice/voice-id/verify
   * One-off verification endpoint for testing or manual checks.
   * Body: { audioUrl: string }
   */
  @Post('voice-id/verify')
  async verifyOwnerVoice(
    @CurrentUser('id') userId: string,
    @Body('audioUrl') audioUrl: string,
  ) {
    if (!audioUrl) throw new BadRequestException('audioUrl is required');
    if (!this.voiceVerificationService.isEnabled) {
      throw new BadRequestException('Voice verification service is not available');
    }

    const user = await this.usersService.findById(userId);
    if (!user?.voice_speaker_id) {
      throw new BadRequestException('No voice profile registered. Call POST /voice/voice-id/register first.');
    }

    let result: SpeakerVerificationResult;
    try {
      result = await this.voiceVerificationService.verifySpeaker(
        user.voice_speaker_id,
        audioUrl,
      );
    } catch (err) {
      this.logger.error('verifyOwnerVoice failed', err instanceof Error ? err.stack : err);
      throw new InternalServerErrorException('Voice verification failed. Please try again.');
    }

    return {
      verified: result.verified,
      similarityScore: result.similarityScore,
      threshold: result.threshold,
    };
  }
}
