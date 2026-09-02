---
name: Drizzle push requer TTY
description: drizzle-kit push falha silenciosamente em ambientes não-interativos (CI, post-merge scripts). Sempre usar SQL direto para migrações.
---

# Drizzle push falha sem TTY

**Rule:** Nunca usar `drizzle-kit push` para aplicar migrações no ambiente Replit. Usar sempre `executeSql()` no code_execution sandbox.

**Why:** O `drizzle-kit push` requer `process.stdin.isTTY` ou `process.stdout.isTTY` para resolver conflitos de colunas interativamente. Em scripts não-interativos (post-merge, CI), ele lança erro e sai sem aplicar nada — mas o processo de build/deploy pode continuar sem reportar falha ao usuário. O resultado é que o schema Drizzle fica fora de sincronia com o banco real.

**How to apply:**
- Para qualquer `ADD COLUMN`, `CREATE TABLE`, `ALTER TABLE`, ou outra DDL: usar `executeSql(...)` no code_execution sandbox.
- O post-merge script (`scripts/post-merge.sh`) chama `drizzle-kit push` mas ele sempre falha por TTY — isso é esperado e inofensivo desde que as migrações já tenham sido aplicadas via SQL direto.
- Após um merge de task agent que modifica o schema, verificar se as colunas existem no banco antes de reiniciar o servidor.
