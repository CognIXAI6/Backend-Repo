import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
     // Resources table
  await knex.schema.createTable('resources', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.uuid('field_id').references('id').inTable('fields').onDelete('SET NULL').nullable();
    table.enum('type', ['textbook', 'video', 'audio', 'document', 'link', 'image']).notNullable();
    table.string('title').notNullable();
    table.text('description').nullable();
    table.string('file_url').nullable();
    table.string('file_name').nullable();
    table.integer('file_size').nullable(); // in bytes
    table.string('mime_type').nullable();
    table.string('external_url').nullable(); // for internet links
    table.text('extracted_content').nullable(); // for AI processing
    table.boolean('is_processed').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

    // Index for faster resource searches
  await knex.schema.raw(`
    CREATE INDEX idx_resources_user_field ON resources(user_id, field_id);
    CREATE INDEX idx_resources_type ON resources(type);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('resources');
}