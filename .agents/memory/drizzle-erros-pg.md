---
name: Drizzle embrulha erros do driver pg — SQLSTATE fica em `cause`
description: Checar `err.code` direto nunca casa; o código do Postgres está na cadeia de `cause`.
---

O Drizzle embrulha os erros do driver `pg` num `DrizzleQueryError`. O SQLSTATE
(`23503` FK, `23505` unique) **não** fica em `err.code` — fica em `err.cause`
(possivelmente aninhado).

**Regra:** nunca escreva `if (err.code === "23505")`. Use helpers que caminham pela cadeia
de `cause` (`isPgUniqueViolation` / `isPgFkViolation`).

**Why:** essa checagem falha em silêncio, e o modo de falha é enganoso porque o código
*parece* certo. Neste projeto ela causou dois bugs vivos ao mesmo tempo: violação de FK
virava 500 em vez de 400, e a retentativa de colisão de código `PS-` na criação de ficha
da Sofia nunca disparava — ou seja, o tratamento de erro existia mas era código morto.

**How to apply:** ao tratar qualquer erro de constraint do Postgres, use os helpers. Ao
distinguir *qual* constraint estourou, case pelo nome dela (ex.: `"slug"`, `"codigo"`),
porque uma tabela costuma ter mais de um índice único e tratar todos igual esconde bug.
Vale também para retentativa: um INSERT que falha **aborta a transação inteira**, então
retentar dentro de uma transação exige SAVEPOINT — ou faça a retentativa fora dela.
