import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ResourcesService } from './resources.service';
import { JwtAuthGuard, CurrentUser } from '@/common';
import { CreateResourceDto, UpdateResourceDto, ResourceQueryDto } from './dto/resources.dto';

/** 50 MB in bytes — enforced at the Multer layer before the file hits memory. */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

@Controller('resources')
@UseGuards(JwtAuthGuard)
export class ResourcesController {
  constructor(private resourcesService: ResourcesService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateResourceDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.resourcesService.create(userId, dto, file);
  }

  @Get()
  async findAll(
    @CurrentUser('id') userId: string,
    @Query() query: ResourceQueryDto,
  ) {
    return this.resourcesService.findAll(userId, query);
  }

  @Get('stats')
  async getStats(@CurrentUser('id') userId: string) {
    return this.resourcesService.getResourceStats(userId);
  }

  @Get('tags')
  async getAllTags(@CurrentUser('id') userId: string) {
    return this.resourcesService.getAllTags(userId);
  }

  @Get('field/:fieldId')
  async getByField(
    @CurrentUser('id') userId: string,
    @Param('fieldId') fieldId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.resourcesService.getResourcesByField(userId, fieldId, page, limit);
  }

  @Get('rag')
  async getForRag(
    @CurrentUser('id') userId: string,
    @Query('fieldId') fieldId?: string,
  ) {
    return this.resourcesService.getResourcesForRag(userId, fieldId);
  }

  @Get(':id')
  async findOne(
    @CurrentUser('id') userId: string,
    @Param('id') resourceId: string,
  ) {
    return this.resourcesService.findOne(userId, resourceId);
  }

  @Patch(':id')
  async update(
    @CurrentUser('id') userId: string,
    @Param('id') resourceId: string,
    @Body() dto: UpdateResourceDto,
  ) {
    return this.resourcesService.update(userId, resourceId, dto);
  }

  @Delete(':id')
  async delete(
    @CurrentUser('id') userId: string,
    @Param('id') resourceId: string,
  ) {
    return this.resourcesService.delete(userId, resourceId);
  }
}
