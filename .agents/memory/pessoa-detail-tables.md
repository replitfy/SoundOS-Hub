---
name: Pessoa 1-to-many detail tables
description: Architecture and constraints for the pessoa sub-tables (servicos, participacoes, instrumentos)
---

## Tables
- `pessoa_servicos` — servico_nome, data_interesse, obs
- `pessoa_participacoes` — curso, data, local, valor, obs
- `pessoa_instrumentos` — item, data_compra, valor, obs

All have `pessoa_id FK → pessoas(id) ON DELETE CASCADE`.

## Why raw SQL for migration
`drizzle-kit push` requires interactive TTY and fails in CI/sandbox. Use `executeSql` directly.

## How to apply
When adding new FK sub-tables, create them with executeSql in the code_execution notebook — never rely on `pnpm --filter @workspace/db run push` in automated contexts.

## Schema file
New tables are exported from `lib/db/src/schema/pessoas.ts` alongside `pessoasTable`.
