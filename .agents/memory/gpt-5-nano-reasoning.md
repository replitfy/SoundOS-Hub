---
name: gpt-5-nano é modelo de raciocínio
description: Por que não usar gpt-5-nano em chamadas com orçamento de latência, e como confirmar antes de escolher um modelo.
---

`gpt-5-nano` **não** é o modelo mais rápido, apesar do nome. Ele é um modelo de
raciocínio: gasta centenas de tokens de reasoning mesmo numa tarefa trivial. Medido no
proxy de IA do Replit com um prompt de ~30 tokens pedindo 4 sinônimos:

| modelo | latência | reasoning_tokens |
|---|---|---|
| `gpt-5-nano` | ~5,4 s | 640 |
| `gpt-5.4-mini` | ~0,7 s | 0 |

**Why:** num caminho crítico com timeout curto, o nano estoura o prazo e o código cai no
fallback — sem erro, sem log óbvio, só a funcionalidade silenciosamente desligada. Foi
exatamente o que aconteceu na expansão de query do RAG da Sofia: só deu para perceber
porque os scores de RRF saíram nos valores exatos de uma query única (1/61, 1/62, …).

**How to apply:** para tarefas curtas e sensíveis a latência (expansão de query,
classificação, extração), prefira `gpt-5.4-mini`. Antes de fixar um modelo num caminho com
timeout, meça latência e `usage.completion_tokens_details.reasoning_tokens` com um
`fetch` direto ao proxy — não confie no nome nem em suposição. E prefira que a
degradação seja observável: um fallback silencioso em cima de um timeout esconde a falha.
