import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
   await knex.schema.alterTable('voice_samples', (table) => {
    table.string('cloudinary_public_id').nullable();
    table.integer('file_size').nullable();
    table.string('mime_type').nullable();
    table.string('original_filename').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('voice_samples', (table) => {
    table.dropColumn('cloudinary_public_id');
    table.dropColumn('file_size');
    table.dropColumn('mime_type');
    table.dropColumn('original_filename');
  });
}