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

  async findAllWithCustomFields(userId?: string): Promise<Field[]> {
    // Get system fields
    const systemFields = await this.knex('fields')
      .select(
        'id',
        'name',
        'slug',
        'description',
        'icon',
        'requires_verification'
      )
      .where('is_active', true);
    // Format system fields
    const formattedSystemFields = systemFields.map((field) => ({
      ...field,
      is_custom: false,
    }));
    // If no userId, return only system fields
    if (!userId) {
      return formattedSystemFields.sort((a, b) => a.name.localeCompare(b.name));
    }
    // Get user's custom fields
    const customFields = await this.knex('custom_fields')
      .where('user_id', userId);
    // Format custom fields to match system fields structure
    const formattedCustomFields = customFields.map((field) => ({
      id: field.id,
      name: field.name,
      slug: this.generateSlug(field.name),
      description: field.description,
      icon: 'custom', // Default icon for custom fields
      requires_verification: false,
      // is_system: false,
      // is_free: true,
      // is_active: true,
      is_custom: true,
      // user_id: field.user_id,
      // created_at: field.created_at,
    }));
    // Combine and sort by name
    const allFields = [...formattedSystemFields, ...formattedCustomFields];
    return allFields.sort((a, b) => a.name.localeCompare(b.name));
  }
  /**
   * Generate slug from name
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
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

  async getUserCustomFieldById(userId: string, fieldId: string) {
    return this.knex('custom_fields').where('user_id', userId).andWhere('id', fieldId).first();
  }

  async getUserCustomFields(userId: string) {
    return this.knex('custom_fields').where('user_id', userId);
  }

 async assignFieldToUser(userId: string, fieldId: string, isPrimary = false, isCustom = false) {
  return this.knex.transaction(async (trx) => {
    // If setting as primary, unset other primary fields
    if (isPrimary) {
      await trx('user_fields')
        .where('user_id', userId)
        .update({ is_primary: false });
    }

    // Build the where clause based on field type
    const fieldWhere = isCustom
      ? { user_id: userId, custom_field_id: fieldId }
      : { user_id: userId, field_id: fieldId };

    // Check if already assigned
    const existing = await trx('user_fields')
      .where(fieldWhere)
      .first();

    if (existing) {
      await trx('user_fields')
        .where('id', existing.id)
        .update({ is_primary: isPrimary });
      return existing;
    }

    // Build insert payload based on field type
    const insertPayload = isCustom
      ? { user_id: userId, custom_field_id: fieldId, is_primary: isPrimary }
      : { user_id: userId, field_id: fieldId, is_primary: isPrimary };

    const [assignment] = await trx('user_fields')
      .insert(insertPayload)
      .returning('*');

    return assignment;
  });
}

  async getUserFields(userId: string) {
    return this.knex('user_fields')
      .select(
        'user_fields.*',
        this.knex.raw(`COALESCE(fields.name, custom_fields.name) AS name`),
        this.knex.raw(`COALESCE(fields.slug, '') AS slug`),
        this.knex.raw(`COALESCE(fields.requires_verification, false) AS requires_verification`),
        this.knex.raw(`CASE WHEN user_fields.custom_field_id IS NOT NULL THEN true ELSE false END AS is_custom`),
      )
      .leftJoin('fields', 'user_fields.field_id', 'fields.id')
      .leftJoin('custom_fields', 'user_fields.custom_field_id', 'custom_fields.id')
      .where('user_fields.user_id', userId);
  }

  async getUserPrimaryField(userId: string) {
    return this.knex('user_fields')
      .select(
        'user_fields.*',
        this.knex.raw(`COALESCE(fields.name, custom_fields.name) AS name`),
        this.knex.raw(`COALESCE(fields.slug, '') AS slug`),
        this.knex.raw(`COALESCE(fields.requires_verification, false) AS requires_verification`),
        this.knex.raw(`CASE WHEN user_fields.custom_field_id IS NOT NULL THEN true ELSE false END AS is_custom`),
      )
      .leftJoin('fields', 'user_fields.field_id', 'fields.id')
      .leftJoin('custom_fields', 'user_fields.custom_field_id', 'custom_fields.id')
      .where('user_fields.user_id', userId)
      .andWhere('user_fields.is_primary', true)
      .first();
  }

  async getMedicalSpecialties() {
    const setting = await this.knex('app_settings').where('key', 'medical_specialties').first();
    return setting?.value;
  }

  async getMedicalLicenseTypes() {
    const setting = await this.knex('app_settings').where('key', 'medical_license_types').first();
    return setting?.value;
  }

  async getLegalPracticeTypes() {
    const setting = await this.knex('app_settings').where('key', 'legal_practice_types').first();
    return setting?.value;
  }

    async getAppSetting(key: string) {
    const setting = await this.knex('app_settings').where('key', key).first();
    return setting?.value;
  }
}
