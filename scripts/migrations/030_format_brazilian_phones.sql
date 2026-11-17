-- Canonical Brazilian phone display:
-- mobile  11-998889876
-- landline 11-38889876
-- A leading country code 55 is removed. Invalid/incomplete values are retained
-- verbatim so a normalization pass never invents or discards contact data.

CREATE OR REPLACE FUNCTION format_brazilian_phone(raw_phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  digits TEXT;
BEGIN
  IF raw_phone IS NULL OR btrim(raw_phone) = '' THEN
    RETURN NULL;
  END IF;

  IF raw_phone ILIKE '%#ERROR!%' THEN
    RETURN NULL;
  END IF;

  digits := regexp_replace(raw_phone, '[^0-9]', '', 'g');
  IF length(digits) IN (12, 13) AND left(digits, 2) = '55' THEN
    digits := substr(digits, 3);
  END IF;

  IF length(digits) IN (10, 11) THEN
    RETURN substr(digits, 1, 2) || '-' || substr(digits, 3);
  END IF;

  RETURN btrim(raw_phone);
END;
$$;

-- Keep both the display value and the digits-only search value consistent for
-- every writer, including imports, Sofia, public forms, and administrative UI.
CREATE OR REPLACE FUNCTION normalize_celular()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.celular := format_brazilian_phone(NEW.celular);
  IF NEW.celular IS NULL OR NEW.celular = '' THEN
    NEW.celular_normalizado := NULL;
  ELSE
    NEW.celular_normalizado := NULLIF(
      regexp_replace(NEW.celular, '[^0-9]', '', 'g'),
      ''
    );
  END IF;
  RETURN NEW;
END;
$$;

UPDATE pessoas
SET celular = format_brazilian_phone(celular)
WHERE merged_into_pessoa_id IS NULL
  AND celular IS NOT NULL
  AND btrim(celular) <> ''
  AND celular IS DISTINCT FROM format_brazilian_phone(celular);

-- Older tombstones may predate the rule that clears identity fields during a
-- merge. The exclusive DDL lock prevents concurrent writes while the immutable
-- guard is disabled solely for this one-time cleanup.
ALTER TABLE pessoas DISABLE TRIGGER pessoas_merged_tombstone_immutable;
UPDATE pessoas
SET celular = NULL
WHERE merged_into_pessoa_id IS NOT NULL
  AND celular IS NOT NULL
  AND celular ILIKE '%#ERROR!%';
ALTER TABLE pessoas ENABLE TRIGGER pessoas_merged_tombstone_immutable;