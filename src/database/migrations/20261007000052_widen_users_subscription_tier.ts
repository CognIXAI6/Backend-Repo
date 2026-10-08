import { Knex } from 'knex';

// Widens subscription_tier from the original free/premium check constraint
// (knex's default Postgres emulation of `table.enum()` is a varchar + CHECK,
// not a native enum type, so this is a constraint swap, not a type change)
// to the four real tiers. Every existing 'premium' user is mapped to
// 'standard' — the only paid plan that existed before this change — so a
// currently-paying customer keeps exactly the access they're already paying
// for; only the previously-undifferentiated free population is newly capped.
export async function up(knex: Knex): Promise<void> {
  // Drop whatever the original enum's check constraint was actually named —
  // found dynamically so this doesn't depend on guessing knex's internal
  // naming convention for the table.enum() call in the original migration.
  await knex.raw(`
    DO $$
    DECLARE
      con record;
    BEGIN
      FOR con IN
        SELECT pgc.conname
        FROM pg_constraint pgc
        JOIN pg_class rel ON rel.oid = pgc.conrelid
        WHERE rel.relname = 'users'
          AND pgc.contype = 'c'
          AND pg_get_constraintdef(pgc.oid) LIKE '%subscription_tier%'
      LOOP
        EXECUTE 'ALTER TABLE users DROP CONSTRAINT ' || quote_ident(con.conname);
      END LOOP;
    END $$;
  `);

  await knex.raw(`ALTER TABLE users ALTER COLUMN subscription_tier TYPE varchar(20)`);

  await knex('users').where({ subscription_tier: 'premium' }).update({ subscription_tier: 'standard' });

  await knex.raw(`
    ALTER TABLE users
    ADD CONSTRAINT users_subscription_tier_check
    CHECK (subscription_tier IN ('free', 'standard', 'plus', 'xpress'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subscription_tier_check`);

  await knex('users')
    .whereIn('subscription_tier', ['standard', 'plus', 'xpress'])
    .update({ subscription_tier: 'premium' });

  await knex.raw(`
    ALTER TABLE users
    ADD CONSTRAINT users_subscription_tier_check
    CHECK (subscription_tier IN ('free', 'premium'))
  `);
}
