import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UploadService, UploadFolder } from '@/modules/upload/upload.service';
import { CreateResourceDto, UpdateResourceDto, ResourceQueryDto, ResourceType } from './dto/resources.dto';

@Injectable()
export class ResourcesService {
  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private uploadService: UploadService,
  ) {}

  async create(
    userId: string,
    dto: CreateResourceDto,
    file?: Express.Multer.File,
  ) {
    // Validate: link type requires externalUrl, others may require file
    if (dto.type === ResourceType.LINK && !dto.externalUrl) {
      throw new BadRequestException('External URL is required for link type resources');
    }

    if (dto.type !== ResourceType.LINK && !file && !dto.externalUrl) {
      throw new BadRequestException('File upload is required for this resource type');
    }

    return this.knex.transaction(async (trx) => {
      let fileUrl: string | null = null;
      let fileName: string | null = null;
      let fileSize: number | null = null;
      let mimeType: string | null = null;

      // Upload file if provided
      if (file) {
        const folder = this.getUploadFolder(dto.type);
        const uploadResult = await this.uploadService.uploadFile(file, folder);
        fileUrl = uploadResult.secure_url;
        fileName = file.originalname;
        fileSize = file.size;
        mimeType = file.mimetype;
      }

      // Create resource
      const [resource] = await trx('resources')
        .insert({
          user_id: userId,
          field_id: dto.fieldId || null,
          type: dto.type,
          title: dto.title,
          description: dto.description || null,
          file_url: fileUrl,
          file_name: fileName,
          file_size: fileSize,
          mime_type: mimeType,
          external_url: dto.externalUrl || null,
          is_processed: false,
        })
        .returning('*');

      // Add tags
      if (dto.tags && dto.tags.length > 0) {
        const tagRecords = dto.tags.map((tag) => ({
          resource_id: resource.id,
          tag: tag.toLowerCase().trim(),
        }));
        await trx('resource_tags').insert(tagRecords);
      }

      // Get tags for response
      const tags = await trx('resource_tags')
        .where('resource_id', resource.id)
        .pluck('tag');

      return this.formatResource(resource, tags);
    });
  }

  async findAll(userId: string, query: ResourceQueryDto) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;
  const offset = (page - 1) * limit;

  const baseQuery = this.knex('resources')
    .where('resources.user_id', userId);

  if (query.type) {
    baseQuery.where('resources.type', query.type);
  }

  if (query.fieldId) {
    baseQuery.where('resources.field_id', query.fieldId);
  }

  if (query.search) {
    baseQuery.where(function () {
      this.whereILike('resources.title', `%${query.search}%`)
        .orWhereILike('resources.description', `%${query.search}%`);
    });
  }

  if (query.tag) {
    baseQuery
      .join('resource_tags', 'resources.id', 'resource_tags.resource_id')
      .where('resource_tags.tag', query.tag.toLowerCase());
  }

  const countQuery = baseQuery
    .clone()
    .clearSelect()
    .clearOrder()
    .countDistinct('resources.id as count');

  const [{ count }] = await countQuery;

  const resources = await baseQuery
    .clone()
    .select('resources.*')
    .orderBy('resources.created_at', 'desc')
    .limit(limit)
    .offset(offset);

  const resourceIds = resources.map((r) => r.id);

  let tagsByResource: Record<string, string[]> = {};

  if (resourceIds.length) {
    const allTags = await this.knex('resource_tags')
      .whereIn('resource_id', resourceIds);

    tagsByResource = allTags.reduce((acc, tag) => {
      if (!acc[tag.resource_id]) acc[tag.resource_id] = [];
      acc[tag.resource_id].push(tag.tag);
      return acc;
    }, {} as Record<string, string[]>);
  }

  const formattedResources = resources.map((r) =>
    this.formatResource(r, tagsByResource[r.id] || []),
  );

  return {
    data: formattedResources,
    pagination: {
      page,
      limit,
      total: Number(count),
      totalPages: Math.ceil(Number(count) / limit),
    },
  };
}

  async findOne(userId: string, resourceId: string) {
    const resource = await this.knex('resources')
      .where('id', resourceId)
      .andWhere('user_id', userId)
      .first();

    if (!resource) {
      throw new NotFoundException('Resource not found');
    }

    const tags = await this.knex('resource_tags')
      .where('resource_id', resourceId)
      .pluck('tag');

    return this.formatResource(resource, tags);
  }

  async update(userId: string, resourceId: string, dto: UpdateResourceDto) {
    const resource = await this.knex('resources')
      .where('id', resourceId)
      .andWhere('user_id', userId)
      .first();

    if (!resource) {
      throw new NotFoundException('Resource not found');
    }

    return this.knex.transaction(async (trx) => {
      const updateData: Record<string, any> = { updated_at: new Date() };

      if (dto.title !== undefined) updateData.title = dto.title;
      if (dto.description !== undefined) updateData.description = dto.description;
      if (dto.fieldId !== undefined) updateData.field_id = dto.fieldId;

      const [updated] = await trx('resources')
        .where('id', resourceId)
        .update(updateData)
        .returning('*');

      // Update tags if provided
      if (dto.tags !== undefined) {
        await trx('resource_tags').where('resource_id', resourceId).delete();

        if (dto.tags.length > 0) {
          const tagRecords = dto.tags.map((tag) => ({
            resource_id: resourceId,
            tag: tag.toLowerCase().trim(),
          }));
          await trx('resource_tags').insert(tagRecords);
        }
      }

      const tags = await trx('resource_tags')
        .where('resource_id', resourceId)
        .pluck('tag');

      return this.formatResource(updated, tags);
    });
  }

  async delete(userId: string, resourceId: string) {
    const resource = await this.knex('resources')
      .where('id', resourceId)
      .andWhere('user_id', userId)
      .first();

    if (!resource) {
      throw new NotFoundException('Resource not found');
    }

    await this.knex('resources').where('id', resourceId).delete();

    return { message: 'Resource deleted successfully' };
  }

  async getResourcesByField(userId: string, fieldId: string) {
    const resources = await this.knex('resources')
      .where('user_id', userId)
      .andWhere('field_id', fieldId)
      .orderBy('created_at', 'desc');

    const resourceIds = resources.map((r) => r.id);
    const allTags = await this.knex('resource_tags')
      .whereIn('resource_id', resourceIds);

    const tagsByResource = allTags.reduce((acc, tag) => {
      if (!acc[tag.resource_id]) acc[tag.resource_id] = [];
      acc[tag.resource_id].push(tag.tag);
      return acc;
    }, {});

    return resources.map((r) =>
      this.formatResource(r, tagsByResource[r.id] || []),
    );
  }

  async getResourceStats(userId: string) {
    const stats = await this.knex('resources')
      .select('type')
      .count('id as count')
      .where('user_id', userId)
      .groupBy('type');

    const total = await this.knex('resources')
      .where('user_id', userId)
      .count('id as count')
      .first();

    return {
      total: Number(total?.count || 0),
      byType: stats.reduce((acc, s) => {
        acc[s.type] = Number(s.count);
        return acc;
      }, {}),
    };
  }

  async getAllTags(userId: string) {
    const tags = await this.knex('resource_tags')
      .select('resource_tags.tag')
      .count('resource_tags.id as count')
      .join('resources', 'resource_tags.resource_id', 'resources.id')
      .where('resources.user_id', userId)
      .groupBy('resource_tags.tag')
      .orderBy('count', 'desc');

    return tags.map((t) => ({ tag: t.tag, count: Number(t.count) }));
  }

  // For RAG: Get all resources content for a user's field
  async getResourcesForRag(userId: string, fieldId?: string) {
    let query = this.knex('resources')
      .select('id', 'type', 'title', 'description', 'extracted_content', 'external_url')
      .where('user_id', userId);

    if (fieldId) {
      query = query.andWhere('field_id', fieldId);
    }

    const resources = await query;

    return resources.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      description: r.description,
      content: r.extracted_content,
      url: r.external_url,
    }));
  }

  private getUploadFolder(type: ResourceType): UploadFolder {
  switch (type) {
    case ResourceType.IMAGE:
      return UploadFolder.RESOURCES;
    case ResourceType.VIDEO:
      return UploadFolder.RESOURCES;
    case ResourceType.AUDIO:
      return UploadFolder.RESOURCES;
    case ResourceType.DOCUMENT:
    case ResourceType.TEXTBOOK:
      return UploadFolder.RESOURCES;
    default:
      return UploadFolder.RESOURCES;
  }
}

  private formatResource(resource: any, tags: string[]) {
    return {
      id: resource.id,
      type: resource.type,
      title: resource.title,
      description: resource.description,
      fieldId: resource.field_id,
      fileUrl: resource.file_url,
      fileName: resource.file_name,
      fileSize: resource.file_size,
      mimeType: resource.mime_type,
      externalUrl: resource.external_url,
      isProcessed: resource.is_processed,
      tags,
      createdAt: resource.created_at,
      updatedAt: resource.updated_at,
    };
  }
}