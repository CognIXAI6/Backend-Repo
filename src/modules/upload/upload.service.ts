import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v2 as cloudinary, UploadApiResponse } from "cloudinary";

export enum UploadFolder {
  LICENSES = "cognix/licenses",
  VOICE_SAMPLES = "cognix/voice-samples",
  AVATARS = "cognix/avatars",
  RESOURCES = "cognix/resources",
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(private configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get("cloudinary.cloudName"),
      api_key: this.configService.get("cloudinary.apiKey"),
      api_secret: this.configService.get("cloudinary.apiSecret"),
    });
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: UploadFolder,
    resourceType: "image" | "video" | "raw" | "auto" = "auto",
  ): Promise<UploadApiResponse> {
    if (!file) {
      throw new BadRequestException("No file provided");
    }

    // Validate file buffer
    if (!file.buffer) {
      this.logger.error("File buffer is undefined or null");
      throw new BadRequestException("File buffer is missing");
    }

    if (file.buffer.length === 0) {
      this.logger.error("File buffer is empty");
      throw new BadRequestException("File buffer is empty");
    }

    this.logger.log(
      `Uploading file: ${file.originalname}, size: ${file.buffer.length} bytes, type: ${file.mimetype}`,
    );

    try {
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type: resourceType,
            public_id: `${Date.now()}-${file.originalname.split(".")[0]}`,
          },
          (error, result) => {
            if (error) {
              this.logger.error("Cloudinary upload error:", {
                message: error.message,
                name: error.name,
                http_code: error.http_code,
                stack: error.stack,
              });
              reject(
                new BadRequestException(`File upload failed: ${error.message}`),
              );
              return;
            }
            if (!result) {
              reject(new BadRequestException("No result from Cloudinary"));
              return;
            }
            this.logger.log("Cloudinary upload successful:", result.secure_url);
            resolve(result);
          },
        );

        uploadStream.on("error", (streamError) => {
          this.logger.error("Upload stream error:", streamError);
          reject(new BadRequestException("Upload stream error"));
        });

        // Write the buffer and end the stream
        uploadStream.end(file.buffer);
      });
    } catch (error) {
      this.logger.error("Unexpected upload error:", error);
      throw new BadRequestException(`File upload failed: ${error.message}`);
    }
  }

  async uploadBase64(
    base64Data: string,
    folder: UploadFolder,
    resourceType: "image" | "video" | "raw" | "auto" = "auto",
  ): Promise<UploadApiResponse> {
    try {
      return await cloudinary.uploader.upload(base64Data, {
        folder,
        resource_type: resourceType,
      });
    } catch (error) {
      this.logger.error("Base64 upload error", error);
      throw new BadRequestException("File upload failed");
    }
  }

  async deleteFile(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId);
    } catch (error) {
      this.logger.error("Delete file error", error);
    }
  }
}
