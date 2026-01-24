import { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  // Clear existing entries
  await knex('fields').del();

  // Insert default fields
  await knex('fields').insert([
    {
      name: 'General Knowledge',
      slug: 'general-knowledge',
      description: 'Contextual transcription',
      icon: 'document',
      requires_verification: false,
      is_system: true,
      is_free: true,
      is_active: true,
    },
    {
      name: 'Education',
      slug: 'education',
      description: 'Academic transcription',
      icon: 'graduation',
      requires_verification: false,
      is_system: true,
      is_free: false,
      is_active: true,
    },
    {
      name: 'Healthcare',
      slug: 'healthcare',
      description: 'Clinical transcription',
      icon: 'medical',
      requires_verification: true,
      is_system: true,
      is_free: false,
      is_active: true,
    },
    {
      name: 'Journalism',
      slug: 'journalism',
      description: 'Media transcription',
      icon: 'newspaper',
      requires_verification: false,
      is_system: true,
      is_free: false,
      is_active: true,
    },
    {
      name: 'Religion',
      slug: 'religion',
      description: 'Faith transcription',
      icon: 'church',
      requires_verification: false,
      is_system: true,
      is_free: false,
      is_active: true,
    },
    {
      name: 'Law',
      slug: 'law',
      description: 'Legal transcription',
      icon: 'scale',
      requires_verification: true,
      is_system: true,
      is_free: false,
      is_active: true,
    },
    {
      name: 'Public Speaking',
      slug: 'public-speaking',
      description: 'Speech transcription',
      icon: 'microphone',
      requires_verification: false,
      is_system: true,
      is_free: false,
      is_active: true,
    },
    {
      name: 'Counselling',
      slug: 'counselling',
      description: 'Support transcription',
      icon: 'heart',
      requires_verification: false,
      is_system: true,
      is_free: false,
      is_active: true,
    },
    {
      name: 'Business',
      slug: 'business',
      description: 'Business transcription',
      icon: 'briefcase',
      requires_verification: false,
      is_system: true,
      is_free: false,
      is_active: true,
    },
  ]);

  // Insert app settings
  await knex('app_settings').del();
  await knex('app_settings').insert([
    {
      key: 'medical_specialties',
      value: JSON.stringify([
        'General Practice',
        'Internal Medicine',
        'Pediatrics',
        'Surgery',
        'Obstetrics & Gynecology',
        'Psychiatry',
        'Cardiology',
        'Neurology',
        'Radiology',
        'Anesthesiology',
        'Emergency Medicine',
        'Other',
      ]),
      description: 'Available medical specialties for healthcare verification',
    },
    {
      key: 'medical_license_types',
      value: JSON.stringify([
        'Medical Doctor (MD)',
        'Doctor of Osteopathic Medicine (DO)',
        'Registered Nurse',
        'Nurse Practitioner (NP)',
        'Physician Assistant (PA)',
        'Licensed Practical Nurse (LPN)',
        'Other',
      ]),
      description: 'Available medical license types',
    },
    {
      key: 'legal_practice_types',
      value: JSON.stringify([
        'Corporate Law',
        'Criminal Law',
        'Family Law',
        'Intellectual Property',
        'Tax Law',
        'Immigration Law',
        'Employment Law',
        'Civil Litigation',
        'Environmental Law',
        'Other',
      ]),
      description: 'Available legal practice types',
    },
    {
      key: 'speaker_modes',
      value: JSON.stringify([
        { id: 'single', name: 'Single Speaker', description: 'Listener or self recording', count: 1 },
        { id: 'listener', name: 'Listener mode', description: 'Record and transcribe without speaking', count: 1 },
        { id: 'two', name: '2 Speakers', description: 'You and one other person', count: 2 },
        { id: 'multiple', name: 'More than 2 Speakers', description: 'Group recording with multiple people', count: 3 },
      ]),
      description: 'Available speaker modes',
    },
    {
      key: 'subscription_prices',
      value: JSON.stringify({
        monthly: { amount: 8, label: 'Monthly', discount: 0 },
        quarterly: { amount: 22, label: '3 months', discount: 10 },
        biannual: { amount: 41, label: '6 months', discount: 15 },
        yearly: { amount: 77, label: 'Yearly', discount: 20 },
      }),
      description: 'Subscription pricing tiers',
    },
  ]);
}
