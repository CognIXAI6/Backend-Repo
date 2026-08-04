import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { VoiceModule } from '@/modules/voice/voice.module';
import { ResourcesModule } from '@/modules/resources/resources.module';
import { UploadModule } from '@/modules/upload/upload.module';

@Module({
  imports: [VoiceModule, ResourcesModule, UploadModule],
  controllers: [ConversationsController],
})
export class ConversationsModule {}
