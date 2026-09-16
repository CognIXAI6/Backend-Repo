import { Knex } from 'knex';

/**
 * Repairs data that migration 20260602000031_add_counselling_verification
 * was supposed to leave in place. That migration is already recorded as
 * applied on some environments, but the `app_settings` rows it inserted
 * (and the `fields.counselling.requires_verification` flag it set) are
 * missing on the live database — most likely lost in a prior partial
 * restore that didn't include `knex_migrations`. Since the original
 * migration won't re-run once recorded, this one re-applies the same data
 * idempotently so `npm run migrate:latest` actually fixes it in production.
 */
export async function up(knex: Knex): Promise<void> {
  await knex('fields')
    .where('slug', 'counselling')
    .update({ requires_verification: true });

  await knex('app_settings')
    .insert({
      key: 'counselling_specialties',
      value: JSON.stringify([
        'Marriage & Family Therapy',
        'Addiction Counselling',
        'Career Counselling',
        'Trauma & PTSD',
        'Child & Adolescent Counselling',
        'Grief & Bereavement',
        'Anxiety & Depression',
        'Relationship Counselling',
        'Mental Health Counselling',
        'School Counselling',
        'Rehabilitation Counselling',
        'Other',
      ]),
      description: 'Available counselling specialties for counselling verification',
    })
    .onConflict('key')
    .merge();

  await knex('app_settings')
    .insert({
      key: 'counselling_license_types',
      value: JSON.stringify([
        'Licensed Professional Counselor (LPC)',
        'Licensed Clinical Social Worker (LCSW)',
        'Licensed Marriage & Family Therapist (LMFT)',
        'Licensed Mental Health Counselor (LMHC)',
        'Certified Counselor (CC)',
        'Registered Psychotherapist',
        'Psychologist',
        'Certified Addiction Counselor (CAC)',
        'Other',
      ]),
      description: 'Available counselling credential and licence types',
    })
    .onConflict('key')
    .merge();
}

export async function down(knex: Knex): Promise<void> {
  // No-op: this migration only repairs data that should already exist per
  // 20260602000031's own down(). Reversing it here would just reintroduce
  // the bug this migration exists to fix.
}
