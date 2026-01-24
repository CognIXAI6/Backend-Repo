import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { JwtAuthGuard, CurrentUser } from '@/common';

@Controller('onboarding')
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private onboardingService: OnboardingService) {}

  @Get('status')
  async getOnboardingStatus(@CurrentUser('id') userId: string) {
    return this.onboardingService.getOnboardingStatus(userId);
  }

  @Post('name')
  async setName(
    @CurrentUser('id') userId: string,
    @Body('name') name: string,
  ) {
    return this.onboardingService.setName(userId, name);
  }

  @Post('field')
  async selectField(
    @CurrentUser('id') userId: string,
    @Body('fieldId') fieldId: string,
  ) {
    return this.onboardingService.selectField(userId, fieldId);
  }

  @Post('speakers')
  async setSpeakerMode(
    @CurrentUser('id') userId: string,
    @Body('mode') mode: string,
    @Body('additionalSpeakers') additionalSpeakers?: string[],
  ) {
    return this.onboardingService.setSpeakerMode(userId, mode, additionalSpeakers);
  }

  @Post('skip-voice')
  async skipVoiceSample(@CurrentUser('id') userId: string) {
    return this.onboardingService.skipVoiceSample(userId);
  }

  @Post('complete')
  async completeOnboarding(@CurrentUser('id') userId: string) {
    return this.onboardingService.completeOnboarding(userId);
  }
}
