import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { VoiceController } from './controllers/voice.controller';
import { VoiceGateway } from './voice.gateway';
import { DeepgramService } from './services/deepgram.service';
import { ClaudeService } from './services/claude.service';
import { ConversationService } from './services/conversation.service';
import { GuestSessionService } from './services/guest-session.service';
import { voiceConfig } from '@/config/voice.config';
import { VoiceService } from './services/voice.service';
import { UsersModule } from '@/modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forFeature(voiceConfig),
    UsersModule,
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('jwt.secret'),
        signOptions: { expiresIn: configService.get('jwt.expiresIn') },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [VoiceController],
  providers: [
    VoiceGateway,
    VoiceService,
    DeepgramService,
    ClaudeService,
    ConversationService,
    GuestSessionService,
  ],
  exports: [ConversationService, ClaudeService, DeepgramService, VoiceService],
})
export class VoiceModule {}
