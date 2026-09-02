---
name: celular_normalizado é mantido por trigger (nota antiga estava errada)
description: Coluna derivada do telefone em `pessoas`; a app não deve escrevê-la, mas SELECT/RETURNING nela funcionam normalmente.
---

`pessoas.celular_normalizado` é uma coluna `text` comum, preenchida por um trigger
`BEFORE INSERT OR UPDATE` (`trg_normalize_celular`) que deriva o valor de `celular`.
Não é coluna gerada (`is_generated = NEVER`).

**Regra:** não escreva `celularNormalizado` a partir da aplicação — o trigger sobrescreve
o valor de qualquer forma, então mandá-lo num INSERT/UPDATE é ruído que dá a falsa
impressão de que a app controla o campo. Derive sempre de `celular`.

**Ler a coluna é seguro.** Uma versão anterior desta nota afirmava que incluí-la em
qualquer `.select()` / `.returning()` do Drizzle quebrava em runtime, e mandava
desestruturar a coluna para fora em toda query. Isso foi verificado e é **falso**:
em 2026-08-14 o `POST /public/inscricao`, que faz `select` explícito de
`celularNormalizado`, respondeu 200/201 nos dois caminhos (e-mail novo e existente).

**Why:** a regra antiga custou tempo real — numa revisão de código ela foi citada como
bug crítico bloqueante no caminho do formulário público, e o "conserto" teria mexido em
código que funciona. Provavelmente a nota generalizou demais um erro cuja causa real era
outra (à época, uma coluna declarada no schema Drizzle e ausente do banco — ver
`api-spec-codegen.md` e o padrão de DDL aditiva no boot).

**How to apply:** ao ver um erro de runtime numa query sobre `pessoas`, não presuma que é
esta coluna. Compare o schema Drizzle com as colunas reais
(`information_schema.columns`) — divergência schema↔banco é a causa recorrente de
verdade neste projeto.
