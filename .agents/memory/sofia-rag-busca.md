---
name: Busca do RAG da Sofia (sem embeddings)
description: Por que a busca da base de conhecimento é BM25 multi-query e não vetorial, e quais limitações restam.
---

A base de conhecimento da Sofia tem schema pgvector, índice HNSW e uma SQL híbrida
(vetor + BM25 fundidos por RRF) — mas **nenhum chunk tem embedding**. O proxy de IA do
Replit não expõe o endpoint `/embeddings`; só uma `OPENAI_API_KEY` direta ativaria isso.
O ramo vetorial existe e está correto, apenas inativo atrás de um `if (queryEmbedding)`.

Na ausência de vetores, o recall de sinônimo/paráfrase vem de **expansão de query**: a
pergunta é reescrita em até 4 formulações por um modelo leve, cada uma é ranqueada por
BM25 (numa única SQL particionada por variação) e os rankings são fundidos por RRF em JS.

**Why:** é o substituto barato da metade vetorial, e complementar — se um dia houver
embeddings, os dois convivem sem migração. Ganho medido: `sonoterapia` não aparece em
nenhum chunk do corpus e passou de 0 para 5 resultados.

**How to apply / limitações que sobraram:**

- `plainto_tsquery` tem semântica **AND**. Perguntas naturais longas ("aprender a tocar
  tigela") não casam nada, nem via variações. É o maior buraco de recall restante, e
  muda a semântica de recuperação — trocar exige avaliação de relevância, não é um
  ajuste local.
- Os limiares de RRF são provisórios (Doc. 14A). Cuidado com a aritmética antes de
  confiar num corte: com k=60 e 20 candidatos, o menor score possível de um acerto é
  1/80 ≈ 0,0125, então qualquer limiar abaixo disso não descarta nada. O bug original
  era exatamente esse — um `> 0.01` que parecia um filtro e nunca filtrou.
- Chunks são grandes e irregulares (média ~4.800 chars, máximo ~108 mil). O recorte
  entregue à Sofia é um `slice` bruto, então ainda corta no meio da frase.
