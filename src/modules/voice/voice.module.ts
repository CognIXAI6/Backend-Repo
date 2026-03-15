import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VoiceController } from './controllers/voice.controller';
import { VoiceGateway } from './voice.gateway';
import { DeepgramService } from './services/deepgram.service';
import { ClaudeService } from './services/claude.service';
import { ConversationService } from './services/conversation.service';
import { voiceConfig } from '@/config/voice.config';
import { VoiceService } from './services/voice.service';


// ─────────────────────────────────────────────────────────────────────────────
// ConversationService injects 'KNEX_CONNECTION'.
// Your DatabaseModule must export Knex with that token.
// See INTEGRATION_NOTES.md for how to check / fix this.
// ─────────────────────────────────────────────────────────────────────────────

@Module({
  imports: [
    ConfigModule.forFeature(voiceConfig),
  ],
  controllers: [VoiceController],
  providers: [
    VoiceGateway,
    VoiceService,
    DeepgramService,
    ClaudeService,
    ConversationService,
  ],
  exports: [ConversationService, ClaudeService, DeepgramService, VoiceService],
})
export class VoiceModule {}