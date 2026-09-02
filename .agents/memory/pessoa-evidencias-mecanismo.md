---
name: Mecanismo de evidências append-only da ficha (pessoas)
description: Invariante humano vs. Sofia ao gravar dados na ficha — nunca sobrescrever confirmação humana.
---

**Regra:** um campo da ficha (`pessoas`) confirmado por um humano nunca pode ser
sobrescrito por uma inferência da Sofia. Toda tentativa de escrita deve passar por um
serviço central de evidências que decide se aplica ou apenas registra (append-only,
nunca atualiza/apaga) — nunca um `UPDATE` direto na tabela a partir de uma rota ou tool.

**Why:** requisito central do produto — Sofia deve acumular evidências ao longo do
tempo, não sobrescrever um dado que um humano já validou.

**How to apply:** qualquer novo caminho de escrita em campos de `pessoas` (novo tool da
Sofia, nova tela, novo formulário público) precisa passar pelo mesmo serviço/invariante,
nunca escrever direto na tabela.

**Apagar uma pessoa:** `pessoa_evidencias` tem um trigger que bloqueia DELETE/UPDATE.
Como o FK de `pessoa_evidencias.pessoa_id` é `ON DELETE CASCADE`, apagar uma pessoa
esbarra nesse trigger. Existe uma escotilha oficial para esse caso — dentro de uma
transação, `SET LOCAL app.allow_evidencia_cascade_delete = 'on'` — e é o único jeito
previsto de remover uma ficha (ex.: limpar um registro criado em teste). Não a use para
"corrigir" trilha de evidência: o append-only é proposital.
