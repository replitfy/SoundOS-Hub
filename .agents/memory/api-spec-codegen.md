---
name: api-spec / orval codegen gotchas
description: Why orval's "Failed to resolve input" error is almost always a YAML parse failure, and why api-server changes need a workflow restart.
---

## orval "Failed to resolve input" means the spec did not PARSE

Symptom: `pnpm run codegen` in `lib/api-spec` fails for every target with:

> Failed to resolve input: Please provide a valid string value or pass a loader to process the input

This message looks like a config/path problem. It is not. orval swallows the
underlying YAML parse error and reports this generic string instead. The output
folders are cleaned *before* the failure, so the generated clients are left
missing/empty, which makes it look like a bigger breakage than it is.

**Most common cause: a duplicated mapping key in `openapi.yaml`** — i.e. adding
a component schema that already exists further down the file.

**Why:** the spec is long and schemas are not alphabetised, so a schema you
"know" is missing may already be defined hundreds of lines below.

**How to apply:**
1. Before adding any component schema, grep for it first:
   `grep -n "^    <SchemaName>:" lib/api-spec/openapi.yaml`
   Reuse the existing schema instead of writing a parallel one.
2. To validate the YAML, note that there is **no** python `yaml` module and no
   root-level `js-yaml` binary. Use the pnpm store copy:
   `node -e "require('/home/runner/workspace/node_modules/.pnpm/node_modules/js-yaml').load(require('fs').readFileSync('lib/api-spec/openapi.yaml','utf8'))"`
   It reports the duplicate key with a line number; orval will not.

## Related: the api-server dev workflow does not watch

`artifacts/api-server`'s dev script is `build && start` (esbuild then node) with
no watch mode, unlike the vite artifacts which hot-reload. A new or changed
route will keep 404-ing until the workflow is restarted.

**How to apply:** after editing anything under `artifacts/api-server/src`,
restart the `artifacts/api-server: API Server` workflow before testing.

## Routes are mounted under `/api`

The express router paths are written without a prefix (e.g.
`/sofia/conversations/:id/...`) but are mounted under `/api`. When curling the
server directly on port 8080, hit `http://localhost:8080/api/...` — omitting
`/api` returns 404 and looks like the route was never registered.

## `format: uri` pode gerar código incompatível com Zod 3

Com Orval 8.20 e Zod 3, um campo OpenAPI `format: uri` pode virar `zod.url()`,
que não existe nessa versão (o método suportado seria encadeado em uma string).

**Why:** a geração termina, mas o `tsc --build` falha dentro do arquivo gerado,
fazendo um contrato válido parecer quebrado.

**How to apply:** enquanto o gerador/Zod não forem atualizados em conjunto,
represente a URL como `type: string` no OpenAPI e valide a URL no backend antes
de expô-la. Não edite o arquivo gerado manualmente.
