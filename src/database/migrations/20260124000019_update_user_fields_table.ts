import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Make field_id nullable
  await knex.schema.alterTable('user_fields', (table) => {
    table.uuid('field_id').nullable().alter();
    table.uuid('custom_field_id')
      .nullable()
      .references('id')
      .inTable('custom_fields')
      .onDelete('CASCADE');
  });

  // Add check constraint so exactly one field type is set
  await knex.raw(`
    ALTER TABLE user_fields
    ADD CONSTRAINT chk_one_field_type
    CHECK (
      (field_id IS NOT NULL AND custom_field_id IS NULL) OR
      (field_id IS NULL AND custom_field_id IS NOT NULL)
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Drop check constraint first
  await knex.raw(`
    ALTER TABLE user_fields
    DROP CONSTRAINT IF EXISTS chk_one_field_type
  `);

  await knex.schema.alterTable('user_fields', (table) => {
    table.dropColumn('custom_field_id');
    // Revert field_id back to not nullable
    table.uuid('field_id').notNullable().alter();
  });
}