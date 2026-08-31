import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ai_response_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    table.uuid('request_message_id').notNullable().unique()
      .references('id').inTable('conversation_messages').onDelete('CASCADE');
    // Plain text + CHECK constraint, not a Postgres enum — this repo already
    // hit real pain converting an enum column back to text
    // (20260429000027_fix_conversations_mode_enum.ts).
    table.text('status').notNullable().defaultTo('accepted');
    table.integer('attempt_count').notNullable().defaultTo(0);
    table.timestamp('available_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('started_at').nullable();
    table.timestamp('completed_at').nullable();
    // Lets a poller reclaim a job stuck at 'processing' after a crash, even
    // on a single-instance deployment (a plain restart mid-generation would
    // otherwise strand the job forever).
    table.timestamp('lease_expires_at').nullable();
    table.text('last_error_category').nullable();
    table.text('last_error_message').nullable();
    table.uuid('response_message_id').nullable()
      .references('id').inTable('conversation_messages').onDelete('SET NULL');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(`
    ALTER TABLE ai_response_jobs
    ADD CONSTRAINT chk_ai_response_jobs_status
    CHECK (status IN ('accepted', 'processing', 'completed', 'failed'));
  `);

  await knex.schema.raw(`
    CREATE INDEX idx_ai_response_jobs_status_available_at
    ON ai_response_jobs (status, available_at);
  `);
  await knex.schema.raw(`
    CREATE INDEX idx_ai_response_jobs_conversation_id
    ON ai_response_jobs (conversation_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ai_response_jobs');
}
