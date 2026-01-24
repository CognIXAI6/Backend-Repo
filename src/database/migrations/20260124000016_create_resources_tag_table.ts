import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
   // Resource tags table
  await knex.schema.createTable('resource_tags', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('resource_id').references('id').inTable('resources').onDelete('CASCADE');
    table.string('tag').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.unique(['resource_id', 'tag']);
  });


    await knex.schema.raw(`
    CREATE INDEX idx_resource_tags_tag ON resource_tags(tag);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('resource_tags');
}