-- Migration 001: Convert soundos_users.role from text to enum
-- Applied: 2026-07-10 via executeSql()

-- 1. Normalize legacy "viewer" values before type change
UPDATE soundos_users
  SET role = 'usuario'
  WHERE role NOT IN ('admin_master', 'admin', 'usuario', 'assistente');

-- 2. Create the PostgreSQL enum type
CREATE TYPE soundos_user_role AS ENUM ('admin_master', 'admin', 'usuario', 'assistente');

-- 3. Drop the text default so ALTER COLUMN can cast cleanly
ALTER TABLE soundos_users ALTER COLUMN role DROP DEFAULT;

-- 4. Convert the column to the enum type
ALTER TABLE soundos_users
  ALTER COLUMN role TYPE soundos_user_role
  USING role::soundos_user_role;

-- 5. Restore the default using the enum type
ALTER TABLE soundos_users
  ALTER COLUMN role SET DEFAULT 'usuario'::soundos_user_role;
