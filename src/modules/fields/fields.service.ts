import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@/database/database.module';
import { slugify } from '@/common';

export interface Field {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  requires_verification: boolean;
  is_system: boolean;
  is_free: boolean;
  is_active: boolean;
  created_at: Date;
}

@Injectable()
export class FieldsService {
  constructor(@Inject(KNEX_CONNECTION) private knex: Knex) {}

  async findAll(): Promise<Field[]> {
    return this.knex('fields').where('is_active', true).orderBy('name');
  }

  async findById(id: string): Promise<Field | null> {
    return this.knex('fields').where('id', id).first();
  }

  async findBySlug(slug: string): Promise<Field | null> {
    return this.knex('fields').where('slug', slug).first();
  }

  async createCustomField(userId: string, name: string, description?: string) {
    const slug = slugify(name);

    // Check if field already exists
    const existing = await this.knex('custom_fields')
      .where('user_id', userId)
      .andWhere('name', name)
      .first();

    if (existing) {
      throw new BadRequestException('Custom field already exists');
    }

    const [field] = await this.knex('custom_fields')
      .insert({
        user_id: userId,
        name,
        description,
      })
      .returning('*');

    return field;
  }

  async getUserCustomFields(userId: string) {
    return this.knex('custom_fields').where('user_id', userId);
  }

  async assignFieldToUser(userId: string, fieldId: string, isPrimary = false) {
    return this.knex.transaction(async (trx) => {
      // If setting as primary, unset other primary fields
      if (isPrimary) {
        await trx('user_fields')
          .where('user_id', userId)
          .update({ is_primary: false });
      }

      // Check if already assigned
      const existing = await trx('user_fields')
        .where('user_id', userId)
        .andWhere('field_id', fieldId)
        .first();

      if (existing) {
        // Update existing
        await trx('user_fields')
          .where('id', existing.id)
          .update({ is_primary: isPrimary });
        return existing;
      }

      // Create new assignment
      const [assignment] = await trx('user_fields')
        .insert({
          user_id: userId,
          field_id: fieldId,
          is_primary: isPrimary,
        })
        .returning('*');

      return assignment;
    });
  }

  async getUserFields(userId: string) {
    return this.knex('user_fields')
      .select('user_fields.*', 'fields.name', 'fields.slug', 'fields.requires_verification')
      .join('fields', 'user_fields.field_id', 'fields.id')
      .where('user_fields.user_id', userId);
  }

  async getUserPrimaryField(userId: string) {
    return this.knex('user_fields')
      .select('user_fields.*', 'fields.*')
      .join('fields', 'user_fields.field_id', 'fields.id')
      .where('user_fields.user_id', userId)
      .andWhere('user_fields.is_primary', true)
      .first();
  }

  async getAppSetting(key: string) {
    const setting = await this.knex('app_settings').where('key', key).first();
    return setting?.value;
  }
}
