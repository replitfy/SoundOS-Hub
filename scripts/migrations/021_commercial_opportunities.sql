-- CRM Kanban MVP (Education + Experiences).
-- Additive and safe to run more than once. This migration intentionally does
-- not use drizzle-kit push: the partial uniqueness and append-only trigger are
-- invariants which need to be reviewed as SQL.

CREATE TABLE IF NOT EXISTS commercial_opportunities (
  id SERIAL PRIMARY KEY,
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE RESTRICT,
  nucleus TEXT NOT NULL CHECK (nucleus IN ('EDUCATION', 'EXPERIENCES')),
  cursos_inscricao_id INTEGER REFERENCES cursos_inscricao(id) ON DELETE SET NULL,
  offer_label TEXT,
  offer_identity TEXT NOT NULL,
  owner_user_id INTEGER REFERENCES soundos_users(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL DEFAULT 'NEW_INTEREST' CHECK (stage IN (
    'NEW_INTEREST', 'CONTACT_STARTED', 'QUALIFYING', 'PATH_IDENTIFIED',
    'DECIDING', 'ENROLLMENT_RESERVATION_IN_PROGRESS', 'CONFIRMED',
    'NURTURE', 'CLOSED'
  )),
  contact_status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (contact_status IN (
    'NOT_STARTED', 'ATTEMPTED', 'REACHED', 'UNREACHABLE', 'OPTED_OUT'
  )),
  next_task_type TEXT CHECK (next_task_type IS NULL OR next_task_type IN (
    'CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'INTERNAL', 'NONE'
  )),
  next_task_text TEXT,
  next_task_at TIMESTAMPTZ,
  stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_interaction_at TIMESTAMPTZ,
  offer_interest_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (
    offer_interest_status IN ('UNKNOWN', 'INTERESTED', 'NOT_INTERESTED')
  ),
  eligibility_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (
    eligibility_status IN ('UNKNOWN', 'ELIGIBLE', 'INELIGIBLE', 'HUMAN_REVIEW')
  ),
  next_best_action TEXT,
  decision_run_id INTEGER REFERENCES sofia_decision_runs(id) ON DELETE SET NULL,
  human_case_reference TEXT,
  pause_reason TEXT,
  close_reason TEXT,
  source TEXT NOT NULL DEFAULT 'CRM',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commercial_opportunities_active_fields CHECK (
    stage = 'CLOSED'
    OR (
      owner_user_id IS NOT NULL
      AND next_task_type IS NOT NULL
      AND next_task_type <> 'NONE'
      AND btrim(coalesce(next_task_text, '')) <> ''
      AND next_task_at IS NOT NULL
    )
  ),
  CONSTRAINT commercial_opportunities_nurture_reason CHECK (
    stage <> 'NURTURE' OR btrim(coalesce(pause_reason, '')) <> ''
  ),
  CONSTRAINT commercial_opportunities_closed_reason CHECK (
    stage <> 'CLOSED' OR btrim(coalesce(close_reason, '')) <> ''
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS commercial_opportunities_active_offer_unique
  ON commercial_opportunities (pessoa_id, nucleus, offer_identity)
  WHERE stage <> 'CLOSED';
CREATE INDEX IF NOT EXISTS commercial_opportunities_pessoa_idx
  ON commercial_opportunities (pessoa_id);
CREATE INDEX IF NOT EXISTS commercial_opportunities_board_idx
  ON commercial_opportunities (stage, next_task_at);
CREATE INDEX IF NOT EXISTS commercial_opportunities_owner_idx
  ON commercial_opportunities (owner_user_id);

CREATE TABLE IF NOT EXISTS commercial_opportunity_events (
  id SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES commercial_opportunities(id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('HUMAN', 'SOFIA', 'SYSTEM')),
  actor_id INTEGER REFERENCES soundos_users(id) ON DELETE RESTRICT,
  from_stage TEXT CHECK (from_stage IS NULL OR from_stage IN (
    'NEW_INTEREST', 'CONTACT_STARTED', 'QUALIFYING', 'PATH_IDENTIFIED',
    'DECIDING', 'ENROLLMENT_RESERVATION_IN_PROGRESS', 'CONFIRMED',
    'NURTURE', 'CLOSED'
  )),
  to_stage TEXT CHECK (to_stage IS NULL OR to_stage IN (
    'NEW_INTEREST', 'CONTACT_STARTED', 'QUALIFYING', 'PATH_IDENTIFIED',
    'DECIDING', 'ENROLLMENT_RESERVATION_IN_PROGRESS', 'CONFIRMED',
    'NURTURE', 'CLOSED'
  )),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'CREATED', 'STAGE_CHANGED', 'TASK_UPDATED', 'TASK_COMPLETED',
    'OWNER_CHANGED', 'CONTACT_UPDATED', 'PAUSED', 'REACTIVATED',
    'CLOSED', 'CONFIRMATION_RECORDED', 'UPDATED'
  )),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'CRM',
  idempotency_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commercial_opportunity_events_idempotency_unique
    UNIQUE (opportunity_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS commercial_opportunity_events_opportunity_time_idx
  ON commercial_opportunity_events (opportunity_id, created_at);

CREATE OR REPLACE FUNCTION prevent_commercial_opportunity_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commercial opportunity events are append-only';
END;
$$;
DROP TRIGGER IF EXISTS commercial_opportunity_events_append_only
  ON commercial_opportunity_events;
CREATE TRIGGER commercial_opportunity_events_append_only
  BEFORE UPDATE OR DELETE ON commercial_opportunity_events
  FOR EACH ROW EXECUTE FUNCTION prevent_commercial_opportunity_event_mutation();