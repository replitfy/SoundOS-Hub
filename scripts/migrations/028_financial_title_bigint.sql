ALTER TABLE financial_titles
  ALTER COLUMN omie_id TYPE bigint,
  ALTER COLUMN account_code TYPE bigint;

ALTER TABLE financial_accounts
  ALTER COLUMN code TYPE bigint;