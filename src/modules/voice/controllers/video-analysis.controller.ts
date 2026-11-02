import {
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard, CurrentUser } from '@/common';
import { VideoAnalysisService } from '../services/video-analysis.service';
import { EntitlementsService } from '@/modules/entitlements/entitlements.service';
import { UsageService } from '@/modules/entitlements/usage.service';

const VIDEO_SIZE_LIMIT = 200 * 1024 * 1024; // 200 MB

@Controller('voice')
@UseGuards(JwtAuthGuard)
export class VideoAnalysisController {
  constructor(
    private readonly videoAnalysisService: VideoAnalysisService,
    private readonly entitlementsService: EntitlementsService,
    private readonly usageService: UsageService,
  ) {}

  @Post('analyse-video')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: VIDEO_SIZE_LIMIT },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('video/')) {
          return cb(new BadRequestException('Only video files are accepted.'), false);
        }
        cb(null, true);
      },
    }),
  )
  async analyseVideo(
    @CurrentUser('id') userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No video file provided.');
    }

    // Checked before the (slow) ffmpeg/transcription work below, not after —
    // a blocked user gets an instant, clear answer instead of waiting out a
    // multi-minute analysis only to be told no at the very end.
    const { entitlements } = await this.entitlementsService.getUserEntitlements(userId);
    if (entitlements.maxVideoAnalysesPerMonth <= 0) {
      throw new ForbiddenException('Upgrade your account to use this feature.');
    }

    const status = await this.usageService.getStatus(userId, 'video_analyses', entitlements.maxVideoAnalysesPerMonth);
    if (!status.canUse) {
      throw new ForbiddenException(
        `You've used all ${status.limit} video analyses included in your plan this month. Upgrade for more.`,
      );
    }

    const result = await this.videoAnalysisService.analyseVideo(file);
    await this.usageService.tryConsume(userId, 'video_analyses', 1, entitlements.maxVideoAnalysesPerMonth);

    return {
      data: result,
    };
  }
}
