import { Knex } from 'knex';

// Free/Standard/Xpress rows are taken verbatim from CognIX_Pricing_Ledger.md
// §04 (Xpress maps onto the ledger's "Pro" row — same top-tier role, same
// ~$19 price). The Plus row has no ledger precedent; these are the
// interpolated figures approved for the mid tier: same message/voice-mode
// ceiling as Standard but roomier minutes/documents, no group mode and no
// comprehensive-depth documents (both stay Xpress-exclusive, per the
// ledger's framing of group mode as "the headline reason to upgrade").
export async function seed(knex: Knex): Promise<void> {
  await knex('plan_entitlements').del();

  await knex('plan_entitlements').insert([
    {
      plan_type: 'free',
      max_messages_per_month: 450,
      max_voice_minutes_per_month: 30,
      allowed_voice_modes: JSON.stringify(['single']),
      max_documents_per_month: 0,
      allowed_document_depths: JSON.stringify([]),
      max_video_analyses_per_month: 0,
      max_video_minutes_per_analysis: 0,
      max_web_searches_per_month: 10,
      support_tier: 'none',
      priority_memory: false,
    },
    {
      plan_type: 'standard',
      max_messages_per_month: 500,
      max_voice_minutes_per_month: 300,
      allowed_voice_modes: JSON.stringify(['single', 'dual_speaker']),
      max_documents_per_month: 10,
      allowed_document_depths: JSON.stringify(['brief', 'standard']),
      max_video_analyses_per_month: 2,
      max_video_minutes_per_analysis: 15,
      max_web_searches_per_month: null,
      support_tier: 'standard_24h',
      priority_memory: false,
    },
    {
      plan_type: 'plus',
      max_messages_per_month: 500,
      max_voice_minutes_per_month: 600,
      allowed_voice_modes: JSON.stringify(['single', 'dual_speaker']),
      max_documents_per_month: 25,
      allowed_document_depths: JSON.stringify(['brief', 'standard']),
      max_video_analyses_per_month: 5,
      max_video_minutes_per_analysis: 30,
      max_web_searches_per_month: null,
      support_tier: 'standard_24h',
      priority_memory: false,
    },
    {
      plan_type: 'xpress',
      max_messages_per_month: null,
      max_voice_minutes_per_month: 1000,
      allowed_voice_modes: JSON.stringify(['single', 'dual_speaker', 'multiple_speaker']),
      max_documents_per_month: 50,
      allowed_document_depths: JSON.stringify(['brief', 'standard', 'comprehensive']),
      max_video_analyses_per_month: 10,
      max_video_minutes_per_analysis: 60,
      max_web_searches_per_month: null,
      support_tier: 'priority_4h',
      priority_memory: true,
    },
  ]);
}
