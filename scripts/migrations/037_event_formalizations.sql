BEGIN;
ALTER TABLE commercial_opportunities ADD COLUMN IF NOT EXISTS owner_system text CHECK (owner_system IS NULL OR owner_system = 'SOFIA');
CREATE TABLE IF NOT EXISTS event_formalizations (
 id serial PRIMARY KEY,
 evento_id integer NOT NULL REFERENCES cursos_inscricao(id),
 class_id integer NOT NULL REFERENCES classes(id),
 pessoa_id integer NOT NULL REFERENCES pessoas(id),
 opportunity_id integer REFERENCES commercial_opportunities(id),
 amount numeric(10,2) NOT NULL CHECK (amount > 0),
 reference text NOT NULL CHECK (btrim(reference) <> ''),
 confirmed_by integer NOT NULL REFERENCES soundos_users(id),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 completed_at timestamptz,
 enrollment_id integer REFERENCES enrollments(id),
 submission_id integer REFERENCES evento_formulario_submissoes(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS event_formalizations_event_person_unique ON event_formalizations(evento_id,pessoa_id);
COMMIT;
