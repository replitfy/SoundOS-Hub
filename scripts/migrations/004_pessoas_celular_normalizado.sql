-- Migration 004: celular_normalizado column, trigger, and indexes on pessoas
-- Applied: 2026-07-13 via executeSql()
--
-- Adds a digits-only copy of celular maintained automatically by a BEFORE trigger.
-- Replaces the runtime REGEXP_REPLACE in queries with an indexed column lookup.

-- Step 1: Add the column (idempotent via IF NOT EXISTS)
ALTER TABLE pessoas ADD COLUMN IF NOT EXISTS celular_normalizado TEXT;

-- Step 2: Backfill existing rows
UPDATE pessoas
SET celular_normalizado = NULLIF(REGEXP_REPLACE(COALESCE(celular, ''), '[^0-9]', '', 'g'), '')
WHERE celular IS NOT NULL;

-- Step 3: Trigger function — auto-maintained on every INSERT / UPDATE OF celular
CREATE OR REPLACE FUNCTION pessoas_set_celular_normalizado()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.celular IS NULL OR NEW.celular = '' THEN
    NEW.celular_normalizado := NULL;
  ELSE
    NEW.celular_normalizado := NULLIF(REGEXP_REPLACE(NEW.celular, '[^0-9]', '', 'g'), '');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pessoas_celular_normalizado_trigger ON pessoas;
CREATE TRIGGER pessoas_celular_normalizado_trigger
BEFORE INSERT OR UPDATE OF celular ON pessoas
FOR EACH ROW EXECUTE FUNCTION pessoas_set_celular_normalizado();

-- Step 4: btree index for range/LIKE queries (e.g. barra de busca)
CREATE INDEX IF NOT EXISTS pessoas_celular_normalizado_idx
ON pessoas (celular_normalizado);

-- Step 5: Unique partial index used for ON CONFLICT deduplication in the chat upsert
CREATE UNIQUE INDEX IF NOT EXISTS pessoas_celular_normalizado_uniq
ON pessoas (celular_normalizado)
WHERE celular_normalizado IS NOT NULL AND celular_normalizado != '';

-- Step 6: Drop the old functional unique index (superseded by step 5)
DROP INDEX IF EXISTS pessoas_celular_norm_uniq;
