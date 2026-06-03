import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Mark the Counselling field as requiring professional verification
  await knex('fields')
    .where('slug', 'counselling')
    .update({ requires_verification: true });

  // Add counselling specialties to app_settings (upsert)
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

  // Add counselling credential/licence types to app_settings (upsert)
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
  await knex('fields')
    .where('slug', 'counselling')
    .update({ requires_verification: false });

  await knex('app_settings')
    .whereIn('key', ['counselling_specialties', 'counselling_license_types'])
    .delete();
}
