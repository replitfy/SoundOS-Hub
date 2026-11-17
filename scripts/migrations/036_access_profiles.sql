-- Perfis de acesso: cada usuário passa a ter um perfil que define as áreas do
-- menu liberadas. Tudo aditivo e idempotente.
--
-- Esta migração cria SÓ a estrutura. Os 4 perfis do sistema (admin_master,
-- admin, usuario, assistente) e o vínculo dos usuários existentes são feitos
-- pelo servidor ao subir (ensureSystemProfiles), porque a publicação leva só o
-- schema, não dados. Enquanto soundos_users.profile_id for NULL, o servidor
-- resolve o perfil pelo papel antigo (role), então ninguém perde nem ganha
-- acesso nessa janela.

CREATE TABLE IF NOT EXISTS access_profiles (
  id serial PRIMARY KEY,
  system_key text,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_admin boolean NOT NULL DEFAULT false,
  areas text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id integer,
  updated_by_name text,
  CONSTRAINT access_profiles_system_key_unique UNIQUE (system_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS access_profiles_name_lower_key
  ON access_profiles (lower(name));

ALTER TABLE soundos_users ADD COLUMN IF NOT EXISTS profile_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'soundos_users_profile_id_access_profiles_id_fk'
  ) THEN
    ALTER TABLE soundos_users
      ADD CONSTRAINT soundos_users_profile_id_access_profiles_id_fk
      FOREIGN KEY (profile_id) REFERENCES access_profiles(id) ON DELETE RESTRICT;
  END IF;
END $$;
