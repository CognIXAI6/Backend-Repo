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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VoiceService } from './voice.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

@Controller('voice')
@UseGuards(JwtAuthGuard)
export class VoiceController {
  constructor(private voiceService: VoiceService) {}

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
}
