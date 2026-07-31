import type { Knex } from 'knex';

/**
 * Durable conversation-participant identity store.
 *
 * Each row represents one speaker in one conversation, identified by a
 * stable conversation-scoped UUID.  This persists across provider-session
 * reconnects so the backend can restore canonical name assignments after
 * a Deepgram session is recreated (e.g. mic→tab-audio recorder handoff).
 *
 * Relationship to other tables:
 *   - conversation_id  → conversations.id
 *   - user_id          → users.id (conversation owner)
 *   - speaker_id       → speakers.id (optional — only set when the participant
 *                         matches a saved registered speaker)
 *
 * The `provider_speaker_id` column is intentionally NOT here — provider
 * cluster IDs are transient and scoped to one provider-session epoch.
 * Mapping (epoch, providerSpeakerId) → participant lives in memory and is
 * reset on every new Deepgram session.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversation_participants', (table) => {
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

    // Optional link to a registered saved speaker.
    table
      .uuid('speaker_id')
      .nullable()
      .references('id')
      .inTable('speakers')
      .onDelete('SET NULL');

    // Human-readable display name (may differ from speakers.name if renamed live).
    table.string('display_name').notNullable();

    // 'owner' | 'participant' — owner is the authenticated user whose mic is primary.
    table.string('role').notNullable().defaultTo('participant');

    // voice_speaker_id from the external voice-verification service, used to
    // re-match this participant against future provider speaker clusters.
    table.string('voice_speaker_id').nullable();

    // Whether this participant's voice has been biometrically confirmed this
    // session (informational — resets to false between sessions).
    table.boolean('voice_confirmed').notNullable().defaultTo(false);

    table.timestamps(true, true);

    // One participant record per (conversation, display_name) pair.
    // A conversation can have the same person only once per name slot.
    table.unique(['conversation_id', 'display_name']);

    table.index('conversation_id');
    table.index('user_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversation_participants');
}
