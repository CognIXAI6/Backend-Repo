import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('resource_conversations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('resource_id').notNullable().references('id').inTable('resources').onDelete('CASCADE');
    table.uuid('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.unique(['resource_id', 'conversation_id']);
  });

  await knex.schema.raw(`
    CREATE INDEX idx_resource_conversations_resource ON resource_conversations(resource_id);
    CREATE INDEX idx_resource_conversations_conversation ON resource_conversations(conversation_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('resource_conversations');
}
