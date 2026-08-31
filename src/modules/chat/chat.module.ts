import { Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module';
import { UsersModule } from '../users/users.module';
import { FieldsModule } from '../fields/fields.module';
import { ChatController } from './chat.controller';
import { ChatMessageService } from './chat-message.service';
import { ChatJobWorkerService } from './chat-job-worker.service';

@Module({
  imports: [VoiceModule, UsersModule, FieldsModule],
  controllers: [ChatController],
  providers: [ChatMessageService, ChatJobWorkerService],
  exports: [ChatMessageService],
})
export class ChatModule {}
