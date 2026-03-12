import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { SpeakersService } from "./speakers.service";
import { JwtAuthGuard, CurrentUser } from "@/common";
import { FileInterceptor } from "@nestjs/platform-express";

@Controller("speakers")
@UseGuards(JwtAuthGuard)
export class SpeakersController {
  constructor(private speakersService: SpeakersService) {}

  @Get()
  async getMySpeakers(@CurrentUser("id") userId: string) {
    return this.speakersService.getUserSpeakers(userId);
  }

  @Get("count")
  async getSpeakerCount(@CurrentUser("id") userId: string) {
    const count = await this.speakersService.getSpeakerCount(userId);
    return { count };
  }

  @Get("/speaker_modes")
  async getSpeakerModes() {
    const count = await this.speakersService.getSpeakerModes();
    return { count };
  }

  // @Post()
  // async createSpeaker(
  //   @CurrentUser("id") userId: string,
  //   @Body("name") name: string,
  //   @Body("avatarUrl") avatarUrl?: string,
  // ) {
  //   return this.speakersService.createSpeaker(userId, name, false, avatarUrl);
  // }

  // @Put(":id")
  // async updateSpeaker(
  //   @CurrentUser("id") userId: string,
  //   @Param("id") speakerId: string,
  //   @Body("name") name: string,
  //   @Body("avatarUrl") avatarUrl?: string,
  // ) {
  //   return this.speakersService.updateSpeaker(
  //     userId,
  //     speakerId,
  //     name,
  //     avatarUrl,
  //   );
  // }

    @Post()
  @UseInterceptors(FileInterceptor('file'))
  async createSpeaker(
    @CurrentUser('id') userId: string,
    @Body('name') name: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.speakersService.createSpeaker(userId, name, false, file);
  }

  @Put(':id')
  @UseInterceptors(FileInterceptor('file'))
  async updateSpeaker(
    @CurrentUser('id') userId: string,
    @Param('id') speakerId: string,
    @Body('name') name: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.speakersService.updateSpeaker(userId, speakerId, name, file);
  }

  @Delete(":id")
  async deleteSpeaker(
    @CurrentUser("id") userId: string,
    @Param("id") speakerId: string,
  ) {
    await this.speakersService.deleteSpeaker(userId, speakerId);
    return { message: "Speaker deleted" };
  }
}
