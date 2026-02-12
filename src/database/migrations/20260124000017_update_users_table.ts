import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
   await knex.schema.alterTable('users', (table) => {
    table.boolean('voice_sample_skipped').defaultTo(false);
    table.timestamp('voice_sample_completed_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('voice_sample_skipped');
    table.dropColumn('voice_sample_completed_at');
  });
}