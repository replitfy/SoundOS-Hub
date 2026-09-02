---
name: zod/v4 subpath no esbuild do api-server
description: O api-server usa esbuild para bundle; importar de "zod/v4" falha na build. Usar schemas de @workspace/api-zod em vez de importar zod diretamente.
---

# zod/v4 subpath não resolve no esbuild do api-server

## A regra
Nunca usar `import { z } from "zod/v4"` em `artifacts/api-server/src/`. O esbuild não consegue resolver esse subpath export.

**Why:** O api-server usa esbuild para bundling (build.mjs). O subpath `zod/v4` é um export especial que o esbuild não consegue resolver por padrão, causando build failure com `Could not resolve "zod/v4"`.

**How to apply:**
- Nos routes do servidor, importar Zod schemas prontos de `@workspace/api-zod` (gerados pelo codegen). Ex: `import { CreateUserBody, UpdateUserBody } from "@workspace/api-zod"`.
- Se precisar de validação customizada não coberta pelo codegen, criar um schema novo em `lib/api-zod/src/` usando `import zod from "zod"` (sem `/v4`) e exportar de lá.
- Lib packages (em `lib/*`) podem usar `"zod/v4"` normalmente — só o api-server tem essa restrição.
