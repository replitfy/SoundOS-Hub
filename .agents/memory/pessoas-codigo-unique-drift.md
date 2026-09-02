---
name: pessoas_codigo_unique drizzle-kit drift
description: Why drizzle-kit push/push-force is unsafe on this project and what to do instead for schema changes.
---

The Drizzle schema and the live database disagree about a unique constraint named
`pessoas_codigo_unique` on the `pessoas` table. Running `drizzle-kit push` (or
`push-force`) triggers an interactive TTY prompt about possibly dropping/altering
this constraint, which risks touching the `pessoas` table destructively.

**Why:** this is pre-existing drift, not caused by any single migration — the agent
has no reliable way to tell from the prompt alone whether accepting it is safe.

**How to apply:** for schema changes on this project, do not run `drizzle-kit push`/
`push-force` without first resolving the `pessoas_codigo_unique` drift. Prefer direct
SQL (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, etc.)
for additive changes to unrelated tables, keeping the Drizzle schema file in sync
manually. See follow-up task "Fix a pre-existing database schema mismatch blocking
safe migrations" for the actual fix.
