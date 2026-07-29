import { Module } from '@nestjs/common';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { DocumentExtractionService } from './document-extraction.service';

@Module({
  controllers: [ResourcesController],
  providers: [ResourcesService, DocumentExtractionService],
  exports: [ResourcesService, DocumentExtractionService],
})
export class ResourcesModule {}