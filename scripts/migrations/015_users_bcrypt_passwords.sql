-- Migration 015: Replace fake hash_* passwords with proper bcrypt
-- Existing users whose passwordHash starts with 'hash_' cannot be migrated
-- without the original password, so they are marked for forced reset instead.

-- Add the password_must_reset flag (default false — new bcrypt users won't need it)
ALTER TABLE soundos_users
  ADD COLUMN IF NOT EXISTS password_must_reset boolean NOT NULL DEFAULT false;

-- Mark every existing user whose stored value is the fake hash scheme
-- so they are forced to set a new password on next login.
UPDATE soundos_users
   SET password_must_reset = true,
       password_hash       = NULL
 WHERE password_hash LIKE 'hash_%';
