import { Controller, Get, Post, Body, UseGuards, UseInterceptors, UploadedFile } from "@nestjs/common";
import { OnboardingService } from "./onboarding.service";
import { JwtAuthGuard, CurrentUser } from "@/common";
import { FileInterceptor } from "@nestjs/platform-express";

@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private onboardingService: OnboardingService) {}

  @Get("status")
  async getOnboardingStatus(@CurrentUser("id") userId: string) {
    return this.onboardingService.getOnboardingStatus(userId);
  }

  @Post("name")
  async setName(@CurrentUser("id") userId: string, @Body("name") name: string) {
    return this.onboardingService.setName(userId, name);
  }

  @Post("field")
  async selectField(
    @CurrentUser("id") userId: string,
    @Body("fieldId") fieldId: string,
  ) {
    return this.onboardingService.selectField(userId, fieldId);
  }

  @Post("speakers")
  async setSpeakerMode(
    @CurrentUser("id") userId: string,
    @Body("mode") mode: string,
    @Body("additionalSpeakers") additionalSpeakers?: string[],
  ) {
    return this.onboardingService.setSpeakerMode(
      userId,
      mode,
      additionalSpeakers,
    );
  }

  @Post("voice-sample")
  @UseInterceptors(FileInterceptor("file"))
  async voiceSample(
    @CurrentUser("id") userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body("durationSeconds") durationSeconds?: number,
    @Body("speakerId") speakerId?: string,
    @Body("skip") skip?: string,
  ) {
    return this.onboardingService.handleVoiceSample(
      userId,
      file,
      durationSeconds ? Number(durationSeconds) : undefined,
      speakerId,
      skip === "true",
    );
  }

  @Post("complete")
  async completeOnboarding(@CurrentUser("id") userId: string) {
    return this.onboardingService.completeOnboarding(userId);
  }
}
