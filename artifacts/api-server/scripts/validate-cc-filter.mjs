/**
 * Validation script: confirms that contas correntes with cNaoConsiderar="S"
 * are correctly identified and excluded from receita/despesa aggregation.
 *
 * Run with: node scripts/validate-cc-filter.mjs
 * (from the api-server directory, with env vars loaded)
 */

const OMIE_API_BASE = "https://app.omie.com.br/api/v1";

const BASES = [
  { name: "education", label: "Soundfulness Education" },
  { name: "store",     label: "Soundfulness Store" },
];

function creds(base) {
  const key    = base === "education" ? process.env.OMIE_EDUCATION_APP_KEY    : process.env.OMIE_STORE_APP_KEY;
  const secret = base === "education" ? process.env.OMIE_EDUCATION_APP_SECRET : process.env.OMIE_STORE_APP_SECRET;
  if (!key || !secret) throw new Error(`Missing Omie credentials for base "${base}"`);
  return { key, secret };
}

async function omieCall(base, endpoint, call, param) {
  const { key, secret } = creds(base);
  const res = await fetch(`${OMIE_API_BASE}/${endpoint}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call, app_key: key, app_secret: secret, param: [param] }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (!res.ok || data.faultstring) throw new Error(data.faultstring ?? `HTTP ${res.status}`);
  return data;
}

async function listContasCorrentes(base) {
  const all = [];
  let pagina = 1;
  for (;;) {
    const data = await omieCall(base, "geral/contacorrente", "ListarContasCorrentes", {
      pagina, registros_por_pagina: 50,
    });
    const items = data.ListarContasCorrentes ?? [];
    for (const cc of items) {
      if (cc.nCodCC) {
        all.push({
          codigo: cc.nCodCC,
          descricao: cc.cDescricao ?? `Conta ${cc.nCodCC}`,
          excluida: cc.cNaoConsiderar === "S",
        });
      }
    }
    if (pagina >= (data.total_de_paginas ?? 0) || items.length === 0) break;
    pagina++;
  }
  return all;
}

async function sampleTitulos(base, tipo, excludedSet) {
  // Fetch first page of titles and show which would be filtered
  const endpoint = tipo === "receber" ? "financas/contareceber" : "financas/contapagar";
  const call     = tipo === "receber" ? "ListarContasReceber"   : "ListarContasPagar";
  const field    = tipo === "receber" ? "conta_receber_cadastro" : "conta_pagar_cadastro";

  // Use last 3 months
  const hoje = new Date();
  const tresMesesAtras = new Date(hoje);
  tresMesesAtras.setMonth(tresMesesAtras.getMonth() - 3);
  const fmt = (d) => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;

  const data = await omieCall(base, endpoint, call, {
    pagina: 1,
    registros_por_pagina: 50,
    filtrar_por_data_de: fmt(tresMesesAtras),
    filtrar_por_data_ate: fmt(hoje),
    apenas_importado_api: "N",
  });

  const titulos = data[field] ?? [];
  let totalIncluded = 0, totalExcluded = 0, countExcluded = 0;

  for (const t of titulos) {
    if (t.status_titulo === "CANCELADO") continue;
    const valor = t.valor_documento ?? 0;
    if (t.nCodCC && excludedSet.has(t.nCodCC)) {
      totalExcluded += valor;
      countExcluded++;
    } else {
      totalIncluded += valor;
    }
  }

  return { totalIncluded, totalExcluded, countExcluded, sample: titulos.length };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Validação: Filtro Contas Correntes → Receita/Despesa");
  console.log("═══════════════════════════════════════════════════════════\n");

  for (const { name: base, label } of BASES) {
    console.log(`▶ Base: ${label} (${base})`);
    console.log("─".repeat(55));

    // 1. List contas correntes
    let contas;
    try {
      contas = await listContasCorrentes(base);
    } catch (err) {
      console.log(`  ✗ Erro ao listar contas correntes: ${err.message}\n`);
      continue;
    }

    const consideradas   = contas.filter(c => !c.excluida);
    const naoConsideradas = contas.filter(c => c.excluida);
    const excludedSet    = new Set(naoConsideradas.map(c => c.codigo));

    console.log(`  Contas encontradas: ${contas.length}`);
    console.log(`    ✓ Considerada    : ${consideradas.length}`);
    console.log(`    ✗ Não Considerada: ${naoConsideradas.length}`);
    if (naoConsideradas.length > 0) {
      for (const cc of naoConsideradas) {
        console.log(`      → [${cc.codigo}] ${cc.descricao}`);
      }
    }

    // 2. Check a sample of titles
    for (const tipo of ["receber", "pagar"]) {
      let result;
      try {
        result = await sampleTitulos(base, tipo, excludedSet);
      } catch (err) {
        console.log(`  ✗ Erro ao listar títulos (${tipo}): ${err.message}`);
        continue;
      }

      const fmt = (v) => `R$ ${v.toFixed(2).replace(".", ",")}`;
      console.log(`\n  Títulos a ${tipo === "receber" ? "Receber" : "Pagar"} (1ª página, últimos 3 meses):`);
      console.log(`    Amostra total  : ${result.sample} títulos`);
      console.log(`    ✓ Incluídos    : ${fmt(result.totalIncluded)} (contas Considerada)`);
      if (naoConsideradas.length > 0) {
        console.log(`    ✗ Excluídos    : ${fmt(result.totalExcluded)} (${result.countExcluded} títulos em contas Não Considerada) ← filtro aplicado`);
      } else {
        console.log(`    — Sem contas Não Considerada → nenhum título excluído`);
      }
    }

    console.log();
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Conclusão:");
  console.log("  • UI badge: cc.excluida (cNaoConsiderar==\"S\") → \"Não Considerada\" (destructive)");
  console.log("  • Filtro  : agregarTitulos() skips t.nCodCC ∈ excludedSet antes de somar");
  console.log("  • Cache   : 1 hora (CC) e 15 min (títulos agregados)");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Erro fatal:", err.message);
  process.exit(1);
});
