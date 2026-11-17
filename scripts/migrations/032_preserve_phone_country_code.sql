-- Preserve an explicitly supplied Brazilian country code in the display value.
-- The normalized search value remains digits-only and is derived by the
-- normalize_celular trigger.
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
    RETURN '+55 ' || substr(digits, 3, 2) || ' ' || substr(digits, 5, length(digits) - 8)
      || '-' || right(digits, 4);
  END IF;

  IF length(digits) IN (10, 11) THEN
    RETURN substr(digits, 1, 2) || '-' || substr(digits, 3);
  END IF;

  RETURN btrim(raw_phone);
END;
$$;