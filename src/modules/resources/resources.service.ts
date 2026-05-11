import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { UploadService, UploadFolder } from '@/modules/upload/upload.service';
import { CreateResourceDto, UpdateResourceDto, ResourceQueryDto, ResourceType } from './dto/resources.dto';

// ─── File validation constants ─────────────────────────────────────────────────

/** 50 MB — applies to all resource types. */
const FILE_SIZE_LIMIT = 50 * 1024 * 1024;

/**
 * Allowed MIME types per resource type.
 * Any upload not in this list is rejected before it reaches Cloudinary.
 */
const ALLOWED_MIME_TYPES: Record<ResourceType, string[]> = {
  [ResourceType.DOCUMENT]: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
    'text/plain',
    'text/csv',
    'application/csv',
  ],
  [ResourceType.TEXTBOOK]: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
  ],
  [ResourceType.IMAGE]: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
  ],
  [ResourceType.AUDIO]: [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/mp4',
    'audio/webm',
    'audio/aac',
    'audio/flac',
    'audio/x-flac',
  ],
  [ResourceType.VIDEO]: [
    'video/mp4',
    'video/mpeg',
    'video/webm',
    'video/ogg',
    'video/quicktime',
    'video/x-msvideo',
  ],
  [ResourceType.LINK]: [],
};

// ─── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private knex: Knex,
    private uploadService: UploadService,
  ) {}

  // ── Create ──────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateResourceDto, file?: Express.Multer.File) {
    if (dto.type === ResourceType.LINK && !dto.externalUrl) {
      throw new BadRequestException('External URL is required for link type resources');
    }

    if (dto.type !== ResourceType.LINK && !file && !dto.externalUrl) {
      throw new BadRequestException('File upload is required for this resource type');
    }

    if (file) {
      this.validateFile(file, dto.type);
    }

    return this.knex.transaction(async (trx) => {
      let fileUrl: string | null = null;
      let fileName: string | null = null;
      let fileSize: number | null = null;
      let mimeType: string | null = null;

      if (file) {
        const cloudinaryType = this.toCloudinaryResourceType(file.mimetype);
        const uploadResult = await this.uploadService.uploadFile(file, UploadFolder.RESOURCES, cloudinaryType);
        fileUrl = uploadResult.secure_url;
        fileName = file.originalname;
        fileSize = file.size;
        mimeType = file.mimetype;
      }

      const [resource] = await trx('resources')
        .insert({
          user_id: userId,
          field_id: dto.fieldId || null,
          type: dto.type,
          title: dto.title,
          description: dto.description ?? null,
          file_url: fileUrl,
          file_name: fileName,
          file_size: fileSize,
          mime_type: mimeType,
          external_url: dto.externalUrl ?? null,
          is_processed: false,
        })
        .returning('*');

      if (dto.tags && dto.tags.length > 0) {
        await trx('resource_tags').insert(
          dto.tags.map((tag) => ({ resource_id: resource.id, tag: tag.toLowerCase().trim() })),
        );
      }

      const tags = await trx('resource_tags').where('resource_id', resource.id).pluck('tag');
      return this.formatResource(resource, tags);
    });
  }

  // ── List ────────────────────────────────────────────────────────────────────

  async findAll(userId: string, query: ResourceQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const offset = (page - 1) * limit;

    const baseQuery = this.knex('resources').where('resources.user_id', userId);

    if (query.type) baseQuery.where('resources.type', query.type);
    if (query.fieldId) baseQuery.where('resources.field_id', query.fieldId);
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

    const [{ count }] = await baseQuery.clone().clearSelect().clearOrder().countDistinct('resources.id as count');

    const resources = await baseQuery
      .clone()
      .select('resources.*')
      .orderBy('resources.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const tagsByResource = await this.loadTagsForResources(resources.map((r) => r.id));

    return {
      data: resources.map((r) => this.formatResource(r, tagsByResource[r.id] ?? [])),
      pagination: {
        page,
        limit,
        total: Number(count),
        totalPages: Math.ceil(Number(count) / limit),
      },
    };
  }

  // ── Single ──────────────────────────────────────────────────────────────────

  async findOne(userId: string, resourceId: string) {
    const resource = await this.knex('resources')
      .where({ id: resourceId, user_id: userId })
      .first();

    if (!resource) throw new NotFoundException('Resource not found');

    const tags = await this.knex('resource_tags').where('resource_id', resourceId).pluck('tag');
    return this.formatResource(resource, tags);
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  async update(userId: string, resourceId: string, dto: UpdateResourceDto) {
    const resource = await this.knex('resources')
      .where({ id: resourceId, user_id: userId })
      .first();

    if (!resource) throw new NotFoundException('Resource not found');

    return this.knex.transaction(async (trx) => {
      const updateData: Record<string, unknown> = { updated_at: new Date() };
      if (dto.title !== undefined) updateData.title = dto.title;
      if (dto.description !== undefined) updateData.description = dto.description;
      if (dto.fieldId !== undefined) updateData.field_id = dto.fieldId || null;

      const [updated] = await trx('resources').where('id', resourceId).update(updateData).returning('*');

      if (dto.tags !== undefined) {
        await trx('resource_tags').where('resource_id', resourceId).delete();
        if (dto.tags.length > 0) {
          await trx('resource_tags').insert(
            dto.tags.map((tag) => ({ resource_id: resourceId, tag: tag.toLowerCase().trim() })),
          );
        }
      }

      const tags = await trx('resource_tags').where('resource_id', resourceId).pluck('tag');
      return this.formatResource(updated, tags);
    });
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async delete(userId: string, resourceId: string) {
    const resource = await this.knex('resources')
      .where({ id: resourceId, user_id: userId })
      .first();

    if (!resource) throw new NotFoundException('Resource not found');

    // Best-effort Cloudinary cleanup before removing the DB record.
    // Runs independently of DB delete — a failed Cloudinary call does not
    // abort the delete (the file becomes orphaned but the record is gone).
    if (resource.file_url) {
      const publicId = this.extractCloudinaryPublicId(resource.file_url);
      if (publicId) {
        const cloudinaryType = resource.mime_type
          ? this.toCloudinaryResourceType(resource.mime_type)
          : 'raw';
        await this.uploadService.deleteFile(publicId, cloudinaryType).catch((err) =>
          this.logger.warn(`Cloudinary cleanup failed for ${publicId}: ${err.message}`),
        );
      }
    }

    await this.knex('resources').where('id', resourceId).delete();
    return { message: 'Resource deleted successfully' };
  }

  // ── By field (paginated) ────────────────────────────────────────────────────

  async getResourcesByField(userId: string, fieldId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;

    const [{ count }] = await this.knex('resources')
      .where({ user_id: userId, field_id: fieldId })
      .count('id as count');

    const resources = await this.knex('resources')
      .where({ user_id: userId, field_id: fieldId })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const tagsByResource = await this.loadTagsForResources(resources.map((r) => r.id));

    return {
      data: resources.map((r) => this.formatResource(r, tagsByResource[r.id] ?? [])),
      pagination: { page, limit, total: Number(count), totalPages: Math.ceil(Number(count) / limit) },
    };
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  async getResourceStats(userId: string) {
    const stats = await this.knex('resources')
      .select('type')
      .count('id as count')
      .where('user_id', userId)
      .groupBy('type');

    const total = await this.knex('resources').where('user_id', userId).count('id as count').first();

    return {
      total: Number(total?.count ?? 0),
      byType: stats.reduce((acc, s) => { acc[s.type] = Number(s.count); return acc; }, {} as Record<string, number>),
    };
  }

  // ── Tags ────────────────────────────────────────────────────────────────────

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

  // ── RAG ─────────────────────────────────────────────────────────────────────

  async getResourcesForRag(userId: string, fieldId?: string) {
    let query = this.knex('resources')
      .select('id', 'type', 'title', 'description', 'extracted_content', 'external_url')
      .where('user_id', userId);

    if (fieldId) query = query.andWhere('field_id', fieldId);

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

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Validates MIME type against the resource type whitelist and enforces the
   * 50 MB size cap. Throws BadRequestException with a user-friendly message.
   */
  private validateFile(file: Express.Multer.File, type: ResourceType): void {
    if (file.size > FILE_SIZE_LIMIT) {
      throw new BadRequestException(
        `File is too large. Maximum allowed size is ${FILE_SIZE_LIMIT / (1024 * 1024)} MB.`,
      );
    }

    const allowed = ALLOWED_MIME_TYPES[type];
    if (allowed.length > 0 && !allowed.includes(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}" for resource type "${type}". ` +
          `Allowed: ${allowed.join(', ')}.`,
      );
    }
  }

  /** Maps a MIME type to the Cloudinary resource_type needed for upload and delete. */
  private toCloudinaryResourceType(mimeType: string): 'image' | 'video' | 'raw' {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return 'video';
    return 'raw';
  }

  /**
   * Extracts the Cloudinary public_id from a secure URL.
   * URL format: https://res.cloudinary.com/{cloud}/{type}/upload/v{version}/{public_id}.{ext}
   */
  private extractCloudinaryPublicId(url: string): string | null {
    try {
      const match = url.match(/\/upload\/v\d+\/(.+?)(?:\.[^./]+)?$/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /** Batch-loads tags for a list of resource IDs, keyed by resource_id. */
  private async loadTagsForResources(ids: string[]): Promise<Record<string, string[]>> {
    if (!ids.length) return {};
    const rows = await this.knex('resource_tags').whereIn('resource_id', ids);
    return rows.reduce((acc, row) => {
      (acc[row.resource_id] ??= []).push(row.tag);
      return acc;
    }, {} as Record<string, string[]>);
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
