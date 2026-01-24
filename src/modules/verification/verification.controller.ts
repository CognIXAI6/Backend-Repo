import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VerificationService } from './verification.service';
import { JwtAuthGuard, CurrentUser } from '@/common';
import {
  CreateHealthcareVerificationDto,
  CreateLegalVerificationDto,
} from './dto/verification.dto';

@Controller('verification')
@UseGuards(JwtAuthGuard)
export class VerificationController {
  constructor(private verificationService: VerificationService) {}

  @Get()
  async getMyVerifications(@CurrentUser('id') userId: string) {
    return this.verificationService.getUserVerifications(userId);
  }

  @Get(':fieldId/status')
  async getVerificationStatus(
    @CurrentUser('id') userId: string,
    @Param('fieldId') fieldId: string,
  ) {
    const verification = await this.verificationService.getVerificationStatus(userId, fieldId);
    return {
      isVerified: verification?.status === 'approved',
      status: verification?.status || null,
      verification,
    };
  }

 // controller
@Post('healthcare')
@UseInterceptors(FileInterceptor('license'))
async createHealthcareVerification(
  @CurrentUser('id') userId: string,
  @Body() dto: CreateHealthcareVerificationDto,
  @UploadedFile(
    new ParseFilePipe({
      validators: [
        new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }), // 5MB
        new FileTypeValidator({ fileType: /(pdf|jpg|jpeg|png)$/i }),
      ],
      fileIsRequired: false,
    }),
  )
  file?: Express.Multer.File,
) {
  return this.verificationService.createHealthcareVerification(
    userId,
    dto.fieldId,  // Access from DTO
    dto,
    file,
  );
}


  @Post('legal')
  @UseInterceptors(FileInterceptor('license'))
  async createLegalVerification(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateLegalVerificationDto,
    @Body('fieldId') fieldId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.verificationService.createLegalVerification(
      userId,
      fieldId,
      dto,
      file,
    );
  }
}
