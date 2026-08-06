import { Module } from '@nestjs/common';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { DocumentExtractionService } from './document-extraction.service';
import { WebCrawlService } from './web-crawl.service';

@Module({
  controllers: [ResourcesController],
  providers: [ResourcesService, DocumentExtractionService, WebCrawlService],
  exports: [ResourcesService, DocumentExtractionService, WebCrawlService],
})
export class ResourcesModule {}