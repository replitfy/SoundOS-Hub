-- Migration 003: Unique functional index on normalised celular in pessoas
-- Applied: 2026-07-13 via executeSql()
-- Prevents duplicate pessoa rows when simultaneous chat requests arrive
-- with the same phone number (race condition: SELECT → INSERT → duplicate).
-- The partial WHERE clause excludes rows with NULL or blank celular so that
-- contacts without a phone number do not conflict with each other.

-- Step 1: Remap FK references from duplicate pessoas to the survivor (lowest id),
-- then delete the duplicates. This preserves referential integrity because
-- conversations.pessoa_id references pessoas.id.

-- 1a. Identify duplicates and their survivor id
WITH duplicates AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY REGEXP_REPLACE(COALESCE(celular, ''), '[^0-9]', '', 'g')
           ORDER BY id
         ) AS survivor_id
  FROM pessoas
  WHERE celular IS NOT NULL
    AND REGEXP_REPLACE(celular, '[^0-9]', '', 'g') != ''
),
to_remove AS (
  SELECT id, survivor_id FROM duplicates WHERE id != survivor_id
)
-- 1b. Remap conversations that reference a duplicate pessoa to the survivor
UPDATE conversations
SET pessoa_id = to_remove.survivor_id
FROM to_remove
WHERE conversations.pessoa_id = to_remove.id;

-- 1c. Delete the duplicate pessoa rows (FKs already remapped above)
WITH duplicates AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY REGEXP_REPLACE(COALESCE(celular, ''), '[^0-9]', '', 'g')
           ORDER BY id
         ) AS survivor_id
  FROM pessoas
  WHERE celular IS NOT NULL
    AND REGEXP_REPLACE(celular, '[^0-9]', '', 'g') != ''
)
DELETE FROM pessoas
WHERE id IN (
  SELECT id FROM duplicates WHERE id != survivor_id
);

-- Step 2: Create the unique functional index (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS pessoas_celular_norm_uniq
ON pessoas (REGEXP_REPLACE(COALESCE(celular, ''), '[^0-9]', '', 'g'))
WHERE celular IS NOT NULL
  AND REGEXP_REPLACE(celular, '[^0-9]', '', 'g') != '';
