import { Module, Global } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import { UsageService } from './usage.service';

// Global: read by voice, documents, chat and admin modules alike, same as
// DatabaseModule's KNEX_CONNECTION — avoids re-importing this module into
// every consumer.
@Global()
@Module({
  providers: [EntitlementsService, UsageService],
  exports: [EntitlementsService, UsageService],
})
export class EntitlementsModule {}
