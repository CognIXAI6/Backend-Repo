import {
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard, CurrentUser } from '@/common';
import { VideoAnalysisService } from '../services/video-analysis.service';

const VIDEO_SIZE_LIMIT = 200 * 1024 * 1024; // 200 MB

@Controller('voice')
@UseGuards(JwtAuthGuard)
export class VideoAnalysisController {
  constructor(private readonly videoAnalysisService: VideoAnalysisService) {}

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
    @CurrentUser('id') _userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No video file provided.');
    }

    const result = await this.videoAnalysisService.analyseVideo(file);

    return {
      data: result,
    };
  }
}
