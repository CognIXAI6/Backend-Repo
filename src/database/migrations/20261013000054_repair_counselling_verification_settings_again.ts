import { Knex } from 'knex';

/**
 * Re-repairs what 20260916000047 already fixed once. That fix was wiped
 * again when `npm run seed:run` was run against production on 2026-10-09 —
 * the seed (src/database/seeds/001_default_fields.ts) does `fields.del()`
 * and `app_settings.del()` then reinserts a default set that predates the
 * counselling-verification data. The seed has now been updated to include
 * this data so a future seed:run won't regress it again, but that doesn't
 * undo the damage already done — this migration does, idempotently.
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
  // No-op: same reasoning as 20260916000047 — reversing would reintroduce
  // the bug this migration fixes.
}
