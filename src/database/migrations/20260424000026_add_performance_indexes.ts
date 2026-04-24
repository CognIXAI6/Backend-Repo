import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // users — auth lookups
  await knex.schema.alterTable('users', (table) => {
    table.index('email', 'idx_users_email');
    table.index('clerk_user_id', 'idx_users_clerk_user_id');
    table.index('onboarding_status', 'idx_users_onboarding_status');
  });

  // registration_otps — OTP verify path (already has email index, add composite)
  await knex.schema.alterTable('registration_otps', (table) => {
    table.index(['email', 'used'], 'idx_registration_otps_email_used');
  });

  // refresh_tokens — token lookup on every authenticated request
  await knex.schema.alterTable('refresh_tokens', (table) => {
    table.index('token', 'idx_refresh_tokens_token');
    table.index(['user_id', 'revoked'], 'idx_refresh_tokens_user_revoked');
  });

  // user_fields — primary field lookup on every session start
  await knex.schema.alterTable('user_fields', (table) => {
    table.index('user_id', 'idx_user_fields_user_id');
    table.index(['user_id', 'is_primary'], 'idx_user_fields_user_primary');
  });

  // conversations — history loads
  await knex.schema.alterTable('conversations', (table) => {
    table.index('user_id', 'idx_conversations_user_id');
    table.index(['user_id', 'created_at'], 'idx_conversations_user_created');
  });

  // conversation_messages (if table exists)
  const hasMessages = await knex.schema.hasTable('conversation_messages');
  if (hasMessages) {
    await knex.schema.alterTable('conversation_messages', (table) => {
      table.index('conversation_id', 'idx_conv_messages_conversation_id');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropIndex('', 'idx_users_email');
    table.dropIndex('', 'idx_users_clerk_user_id');
    table.dropIndex('', 'idx_users_onboarding_status');
  });

  await knex.schema.alterTable('registration_otps', (table) => {
    table.dropIndex('', 'idx_registration_otps_email_used');
  });

  await knex.schema.alterTable('refresh_tokens', (table) => {
    table.dropIndex('', 'idx_refresh_tokens_token');
    table.dropIndex('', 'idx_refresh_tokens_user_revoked');
  });

  await knex.schema.alterTable('user_fields', (table) => {
    table.dropIndex('', 'idx_user_fields_user_id');
    table.dropIndex('', 'idx_user_fields_user_primary');
  });

  await knex.schema.alterTable('conversations', (table) => {
    table.dropIndex('', 'idx_conversations_user_id');
    table.dropIndex('', 'idx_conversations_user_created');
  });

  const hasMessages = await knex.schema.hasTable('conversation_messages');
  if (hasMessages) {
    await knex.schema.alterTable('conversation_messages', (table) => {
      table.dropIndex('', 'idx_conv_messages_conversation_id');
    });
  }
}
