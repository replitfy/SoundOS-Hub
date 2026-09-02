---
name: Sofia pessoa creation flow
description: How Sofia creates and enriches pessoa fichas during chat; trigger and index were missing from DB.
---

## Root cause of missing fichas
The `celular_normalizado` column was declared in the Drizzle schema but never existed in the actual DB (drizzle-kit push requires TTY and was never run). The server-side upsert in sofia.ts used `ON CONFLICT (celular_normalizado)` which failed with `42703 — undefined_column`, was swallowed as a best-effort error, and no pessoa was ever created.

## Fix applied (2026-07-13)
1. Created `celular_normalizado` column via `executeSql` (ALTER TABLE).
2. Created trigger function `normalize_celular()` (strips non-digits from `celular`).
3. Created trigger `trg_normalize_celular` BEFORE INSERT OR UPDATE.
4. Backfilled existing rows manually.
5. Created `UNIQUE INDEX pessoas_celular_normalizado_uniq` with partial WHERE clause.

## Tools added to Sofia
- `createPessoa` — lets Sofia create a new ficha from scratch when she collects nome + celular during conversation.
- `updatePessoa` — already existed; now Sofia actually uses it because `pessoaId` is injected into the system prompt.

## System prompt injection
After the server-side upsert resolves `pessoaId`, a context block is appended to the system prompt:
```
CONTEXTO DO ATENDIMENTO:
- Pessoa em atendimento: {nome} (pessoaId: {id})
- Always call updatePessoa when new personal info is collected.
```
Without this injection, Sofia had no way to know the pessoaId and could never call updatePessoa.

## How to apply
- Any new DB column that relies on a trigger must be created via `executeSql` in code_execution. Never rely on `drizzle-kit push` in this environment (no TTY).
- After adding a trigger-populated column, always manually backfill existing rows.
- When adding a partial unique index for ON CONFLICT, the WHERE clause in the index must exactly match the WHERE clause in the ON CONFLICT statement.
