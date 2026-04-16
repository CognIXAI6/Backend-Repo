import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { JwtAuthGuard, CurrentUser } from '@/common';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('onboarding')
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private onboardingService: OnboardingService) {}

  /** GET /onboarding/status */
  @Get('status')
  async getStatus(@CurrentUser('id') userId: string) {
    return this.onboardingService.getOnboardingStatus(userId);
  }

  /** POST /onboarding/name — optional, set/update display name */
  @Post('name')
  async setName(
    @CurrentUser('id') userId: string,
    @Body('name') name: string,
  ) {
    return this.onboardingService.setName(userId, name);
  }

  /**
   * POST /onboarding/niche — select professional niche.
   * This is the only required onboarding step; calling it marks onboarding complete.
   */
  @Post('niche')
  async selectNiche(
    @CurrentUser('id') userId: string,
    @Body('fieldId') fieldId: string,
  ) {
    return this.onboardingService.selectNiche(userId, fieldId);
  }

  /** POST /onboarding/voice-sample — optional voice sample upload or skip */
  @Post('voice-sample')
  @UseInterceptors(FileInterceptor('file'))
  async voiceSample(
    @CurrentUser('id') userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('durationSeconds') durationSeconds?: string,
    @Body('speakerId') speakerId?: string,
    @Body('skip') skip?: string,
  ) {
    return this.onboardingService.handleVoiceSample(
      userId,
      file,
      durationSeconds ? Number(durationSeconds) : undefined,
      speakerId,
      skip === 'true',
    );
  }
}
