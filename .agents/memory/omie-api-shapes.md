---
name: Omie API response shapes
description: Verified real response shapes of Omie ERP endpoints vs. what third-party docs claim
---

# Omie API — verified response shapes

**Rule:** Trust the live Omie API over attached/third-party docs — field names differ per endpoint family and docs often conflate them.

**Verified live (both bases):** `financas/contareceber` + call `ListarContasReceber` returns:
- Top level: `pagina`, `total_de_paginas`, `registros`, `total_de_registros`, `conta_receber_cadastro[]`
- Records use snake_case: `codigo_lancamento_omie`, `numero_documento_fiscal` (NOT `numero_documento`), `numero_parcela`, `data_emissao`, `data_vencimento`, `valor_documento`, `status_titulo`
- `status_titulo` values seen in production: `RECEBIDO`, `A VENCER`, `ATRASADO`, `CANCELADO`
- No `observacao`, no paid/open amounts in this call.

**Verified live (both bases):** `financas/contapagar` + call `ListarContasPagar` mirrors the receber shape: `conta_pagar_cadastro[]`, same snake_case record fields. `status_titulo` uses `PAGO` (not RECEBIDO) plus `A VENCER`/etc. Extra fields exist (`categorias[]`, `valor_pag`, `distribuicao[]`, `cnab_integracao_bancaria`) if categories/paid values are ever needed.

**The camelCase shape** (`cadastros[]` with `nCodTitulo`, `cStatus`, `nValPago`, `nValAberto`, `dDtVenc`) belongs to `financas/pesquisartitulos/` call `PesquisarLancamentos` — use that endpoint if paid/open values per título are needed.

**Why:** A user-attached skill doc described ListarContasReceber with the pesquisartitulos shape; implementing from it blindly would have broken the mapping. Empirical check against the live API (2 records, key dump) settled it.

**How to apply:** Before mapping any new Omie call, dump `Object.keys()` of a real response first. Request params `filtrar_por_data_de/ate` and `filtrar_por_status` ARE valid for ListarContasReceber; max `registros_por_pagina` is 500.

**Verified live (both bases):** `geral/contacorrente` + call `ListarContasCorrentes` — real fields are snake_case: `nCodCC` (numeric id, mixed case), `descricao`, `tipo` (short code: CC/CX/CV/AD/AC/CR...), `codigo_banco` (bank/institution code, e.g. "323", "403" — no friendly name in this payload), `inativo` ("S"/"N"), `codigo_agencia`, `numero_conta_corrente`, `saldo_inicial` (holds current balance despite the name), `cobr_sn` ("S"/"N" — emits boletos/cobrança), `nao_resumo`/`nao_fluxo` ("S"/"N", always equal in samples seen — this is the real "Não Considerada" exclusion flag for revenue/expense reports).
Previously-assumed fields `cTipo`, `sBanco`, `cAgencia`, `cDescricao`, `cNaoConsiderar` do NOT exist on this endpoint — code that read them always got `undefined`, silently breaking both the account-exclusion filter (it never excluded anything) and the tipo/banco display columns.
There is no human-readable "Instituição" name in this API response — Omie's own UI derives it from an internal bank-code lookup table not exposed here; `codigo_banco` is the best available proxy.
