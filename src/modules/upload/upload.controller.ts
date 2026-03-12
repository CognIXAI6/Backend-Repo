import { BadRequestException, Body, Controller, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { UploadFolder, UploadService } from "./upload.service";
import { CurrentUser } from "@/common";


@Controller('uploads')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

@Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadResource(
    @CurrentUser('id') userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    const result = await this.uploadService.uploadFile(file, UploadFolder.FILES, 'auto');

    return {
      message: 'File uploaded successfully',
      uploadedBy: userId,
      data: {
        publicId: result.public_id,
        url: result.secure_url,
        resourceType: result.resource_type,
        format: result.format,
        bytes: result.bytes,
        originalFilename: result.original_filename,
      },
    };
  }
}