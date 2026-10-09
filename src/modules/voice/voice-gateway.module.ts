import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { VoiceGateway } from './voice.gateway';
import { VoiceModule } from './voice.module';
import { UsersModule } from '@/modules/users/users.module';
import { FieldsModule } from '@/modules/fields/fields.module';
import { DocumentModule } from '@/modules/documents/document.module';
import { PushNotificationModule } from '@/modules/notifications/push-notification.module';
import { UploadModule } from '@/modules/upload/upload.module';
import { ErrorLogModule } from '@/modules/error-log/error-log.module';
import { SpeakersModule } from '@/modules/speakers/speakers.module';

/**
 * Everything the live Socket.IO voice gateway needs, bootstrapped as its
 * own process (see main-gateway.ts) — separate from the REST API
 * (main.ts/AppModule) so a burst of concurrent voice sessions (audio
 * streaming, Deepgram events, Claude streaming) can no longer starve the
 * REST process's event loop. Both processes share the same database.
 *
 * @Global() modules (Upload/ErrorLog/Email/Database/Entitlements) still
 * have to be imported at least ONCE in a given process's graph before
 * their providers exist for that process at all — @Global() only
 * broadens visibility within a graph that already has them loaded, it
 * doesn't load them for free. UploadModule and ErrorLogModule are listed
 * explicitly below for exactly that reason (confirmed the hard way: the
 * first version of this module omitted them, assuming VoiceModule's own
 * EmailModule import covered everything global, and the gateway process
 * failed to boot — "Nest can't resolve dependencies of SpeakersService
 * (… UploadService …)" — Email actually was covered transitively via
 * VoiceModule; Upload, ErrorLog, and Speakers were not).
 *
 * Importing VoiceModule/UsersModule/FieldsModule/DocumentModule/
 * SpeakersModule here for their services also registers those modules'
 * REST controllers (VoiceController, FieldsController, DocumentController,
 * SpeakersController, etc.) on this process's Express instance. That's
 * intentional-but-unused overhead, not a bug: nginx only ever routes
 * /socket.io/* to this process's port, so those routes are simply
 * unreachable from outside — splitting every shared module into
 * controller-only/service-only halves wasn't worth the extra risk for
 * this change.
 */
@Module({
  imports: [
    VoiceModule, // ConversationService, ClaudeService, DeepgramService, VoiceService, GuestSessionService, VoiceVerificationService; also pulls in EmailModule (@Global)
    UsersModule,
    FieldsModule,
    DocumentModule,
    PushNotificationModule,
    UploadModule,
    ErrorLogModule,
    SpeakersModule,
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('jwt.secret'),
        signOptions: { expiresIn: configService.get('jwt.expiresIn') },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [VoiceGateway],
})
export class VoiceGatewayModule {}
