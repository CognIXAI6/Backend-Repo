import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('generated_documents', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table
      .uuid('conversation_id')
      .nullable()
      .references('id')
      .inTable('conversations')
      .onDelete('SET NULL');
    table.string('title').notNullable();
    table.string('topic').nullable();
    table.text('download_url').notNullable();
    table.string('cloudinary_public_id').nullable();
    table.integer('section_count').defaultTo(0);
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('generated_documents');
}
