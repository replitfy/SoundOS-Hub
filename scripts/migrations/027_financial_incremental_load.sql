BEGIN;

CREATE TABLE IF NOT EXISTS financial_titles (
  base text NOT NULL,
  kind text NOT NULL,
  omie_id integer NOT NULL,
  account_code integer,
  issue_date date,
  due_date date,
  reference_date date,
  amount double precision NOT NULL,
  status text,
  loaded_at timestamptz NOT NULL,
  PRIMARY KEY (base, kind, omie_id)
);

CREATE INDEX IF NOT EXISTS financial_titles_reference_date_idx
  ON financial_titles (reference_date);
CREATE INDEX IF NOT EXISTS financial_titles_base_account_idx
  ON financial_titles (base, account_code);

CREATE TABLE IF NOT EXISTS financial_accounts (
  base text NOT NULL,
  code integer NOT NULL,
  description text NOT NULL,
  excluded boolean NOT NULL,
  type text,
  bank text,
  active boolean NOT NULL,
  branch text,
  account_number text,
  opening_balance double precision NOT NULL,
  issues_invoice boolean NOT NULL,
  loaded_at timestamptz NOT NULL,
  PRIMARY KEY (base, code)
);

COMMIT;