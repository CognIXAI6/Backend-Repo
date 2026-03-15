import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { SettingsService } from "./settings.service";
import { JwtAuthGuard, CurrentUser } from "@/common";
import { UpdateProfileDto, UpdateAiPreferencesDto } from "./dto/settings.dto";
import { UsersService } from "../users/users.service";

@Controller("settings")
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(
    private settingsService: SettingsService,
    private usersService: UsersService,
  ) {}

  // ============ PROFILE ============

  @Get("profile")
  async getProfile(@CurrentUser("id") userId: string) {
    return this.settingsService.getProfile(userId);
  }

  @Put("profile")
  async updateProfile(
    @CurrentUser("id") userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.settingsService.updateProfile(userId, dto);
  }

  @Delete("profile/delete")
  async deleteProfile(
    @CurrentUser("id") userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.delete(userId);
  }

  @Post("profile/avatar")
  @UseInterceptors(FileInterceptor("avatar"))
  async uploadAvatar(
    @CurrentUser("id") userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.settingsService.uploadAvatar(userId, file);
  }

  @Delete("profile/avatar")
  async removeAvatar(@CurrentUser("id") userId: string) {
    return this.settingsService.removeAvatar(userId);
  }

  // ============ AI PREFERENCES ============

  @Get("ai-preferences")
  async getAiPreferences(@CurrentUser("id") userId: string) {
    return this.settingsService.getAiPreferences(userId);
  }

  @Put("ai-preferences")
  async updateAiPreferences(
    @CurrentUser("id") userId: string,
    @Body() dto: UpdateAiPreferencesDto,
  ) {
    return this.settingsService.updateAiPreferences(userId, dto);
  }
}
