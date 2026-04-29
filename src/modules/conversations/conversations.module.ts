import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { VoiceModule } from '@/modules/voice/voice.module';

@Module({
  imports: [VoiceModule],
  controllers: [ConversationsController],
})
export class ConversationsModule {}
