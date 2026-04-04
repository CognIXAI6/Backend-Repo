import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    // Allow password to be null for OTP-only and OAuth users
    table.string('password').nullable().alter();
    // Clerk OAuth user ID (unique per Clerk user)
    table.string('clerk_user_id').nullable().unique();
    // Track the auth provider (email_otp | clerk_oauth | password)
    table.string('auth_provider').defaultTo('email_otp').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('clerk_user_id');
    table.dropColumn('auth_provider');
    table.string('password').notNullable().alter();
  });
}
