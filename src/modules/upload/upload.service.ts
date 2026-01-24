import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

export enum UploadFolder {
  LICENSES = 'cognix/licenses',
  VOICE_SAMPLES = 'cognix/voice-samples',
  AVATARS = 'cognix/avatars',
  RESOURCES = 'cognix/resources',
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(private configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get('cloudinary.cloudName'),
      api_key: this.configService.get('cloudinary.apiKey'),
      api_secret: this.configService.get('cloudinary.apiSecret'),
    });
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: UploadFolder,
    resourceType: 'image' | 'video' | 'raw' | 'auto' = 'auto',
  ): Promise<UploadApiResponse> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    try {
      return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type: resourceType,
          },
          (error, result) => {
            if (error || !result) {
              this.logger.error('Cloudinary upload failed', error);
              reject(new BadRequestException('File upload failed'));
              return;
            }
            resolve(result);
          },
        ).end(file.buffer);
      });
    } catch (error) {
      this.logger.error('Upload error', error);
      throw new BadRequestException('File upload failed');
    }
  }

  async uploadBase64(
    base64Data: string,
    folder: UploadFolder,
    resourceType: 'image' | 'video' | 'raw' | 'auto' = 'auto',
  ): Promise<UploadApiResponse> {
    try {
      return await cloudinary.uploader.upload(base64Data, {
        folder,
        resource_type: resourceType,
      });
    } catch (error) {
      this.logger.error('Base64 upload error', error);
      throw new BadRequestException('File upload failed');
    }
  }

  async deleteFile(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId);
    } catch (error) {
      this.logger.error('Delete file error', error);
    }
  }
}
