import { Global, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';

@Global()
@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
    }),
  ],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}