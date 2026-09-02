---
name: Declarações obsoletas de lib/* quebram o typecheck depois de um merge
description: Project references emitem .d.ts em lib/<pkg>/dist; se não forem regeradas, o typecheck acusa campos que existem na fonte.
---

As libs do monorepo são TypeScript *project references* (`composite: true`,
`emitDeclarationOnly`, `outDir: dist`). Os artifacts não leem `lib/<pkg>/src` na hora do
typecheck — leem os `.d.ts` gerados em `lib/<pkg>/dist`.

**Regra:** todo merge que altera um schema ou tipo em `lib/*` precisa regerar as
declarações (`pnpm run typecheck:libs`, que é `tsc --build`). O script de pós-merge deve
fazer isso **antes** dos typechecks dos artifacts.

**Why:** o modo de falha é enganoso. O typecheck reclama de um campo que você está vendo
na fonte à sua frente ("Property 'x' does not exist"), o que leva a procurar bug no
código do artifact ou a suspeitar de um merge malfeito — quando o problema é só o `dist`
velho. Pior: o servidor continua *rodando*, porque o bundle é feito por esbuild a partir
da fonte e ignora os `.d.ts`. Só o typecheck quebra, então dá para não perceber por um
bom tempo.

**How to apply:** ao ver um erro de tipo sobre um campo que existe claramente na fonte de
`lib/*`, rode `tsc -b lib/<pkg>` antes de investigar qualquer outra coisa. Confirme
olhando o `.d.ts` gerado (`grep <campo> lib/<pkg>/dist/.../<arquivo>.d.ts`).
