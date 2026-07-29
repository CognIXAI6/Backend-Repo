import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { VoiceModule } from '@/modules/voice/voice.module';
import { ResourcesModule } from '@/modules/resources/resources.module';

@Module({
  imports: [VoiceModule, ResourcesModule],
  controllers: [ConversationsController],
})
export class ConversationsModule {}
