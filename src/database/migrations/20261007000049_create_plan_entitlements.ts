import { Knex } from 'knex';

// One row per plan_type (not per billing cycle — what a tier unlocks doesn't
// depend on how often you're billed for it). This table is the single
// admin-editable source every gating check in the app reads from; see
// EntitlementsService.getEntitlementsForTier.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('plan_entitlements', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('plan_type', 20).notNullable().unique();

    // null = unlimited / fair-use (no numeric cap enforced)
    table.integer('max_messages_per_month').nullable();
    table.integer('max_voice_minutes_per_month').nullable();
    // jsonb array of 'single' | 'dual_speaker' | 'multiple_speaker'
    table.jsonb('allowed_voice_modes').notNullable().defaultTo(JSON.stringify(['single']));

    table.integer('max_documents_per_month').notNullable().defaultTo(0);
    // jsonb array of 'brief' | 'standard' | 'comprehensive'
    table.jsonb('allowed_document_depths').notNullable().defaultTo(JSON.stringify([]));

    table.integer('max_video_analyses_per_month').notNullable().defaultTo(0);
    table.integer('max_video_minutes_per_analysis').notNullable().defaultTo(0);

    // null = unlimited / fair-use
    table.integer('max_web_searches_per_month').nullable();

    table.string('support_tier', 50).notNullable().defaultTo('standard');
    // Informational only today — no quality/priority dial exists in
    // ClaudeService's memory summarization to actually wire this to.
    table.boolean('priority_memory').notNullable().defaultTo(false);

    table.uuid('updated_by_admin_id').references('id').inTable('admins').onDelete('SET NULL').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE plan_entitlements
    ADD CONSTRAINT plan_entitlements_plan_type_check
    CHECK (plan_type IN ('free', 'standard', 'plus', 'xpress'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('plan_entitlements');
}
