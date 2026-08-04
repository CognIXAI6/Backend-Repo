import type { Knex } from 'knex';

/**
 * Stores images attached to conversations for Claude Vision.
 *
 * "Include-once" strategy: each image is sent to Claude exactly once — on the
 * first AI call after upload.  `sent_to_ai` is flipped to true after that call
 * so subsequent messages don't re-pay the vision token cost.
 *
 * The base64 payload is stored in the DB so we never need to re-download from
 * Cloudinary at inference time.  Max image size enforced at the API layer is
 * 10 MB → base64 ≈ 13.3 MB per row, which is well within Postgres text limits.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversation_images', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    table
      .uuid('conversation_id')
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');

    table
      .uuid('user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');

    table.string('filename').notNullable();

    // MIME type as stored — used to set media_type for the Anthropic vision block.
    table.string('mime_type').notNullable();

    // Cloudinary secure URL (kept for display / download purposes).
    table.text('file_url').notNullable();

    // Base64-encoded image data sent to Claude.  Stored so we never re-download.
    table.text('image_base64').notNullable();

    // Flipped to true after the image has been included in one AI call.
    // Once true the image is never sent again (include-once strategy).
    table.boolean('sent_to_ai').notNullable().defaultTo(false);

    table.timestamps(true, true);

    table.index('conversation_id');
    table.index(['conversation_id', 'sent_to_ai']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversation_images');
}
