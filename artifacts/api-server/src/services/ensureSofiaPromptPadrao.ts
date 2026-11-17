import { sql } from "drizzle-orm";
import { db, promptsTable } from "@workspace/db";
import { DEFAULT_SOFIA_MODEL_ID } from "@workspace/sofia-models";
import { SOFIA_PROMPT_PADRAO_BODY, SOFIA_PROMPT_PADRAO_NOME } from "./sofiaPromptPadrao";

// Chave do advisory lock: várias instâncias subindo juntas não duplicam a versão.
const LOCK_KEY = 707_016;

const normalizar = (texto: string) => texto.replace(/\r\n/g, "\n").trim();

export type ResultadoPromptPadrao =
  | { status: "ja_cadastrado"; id: number; version: string }
  | { status: "criado_e_ativado"; id: number; version: string; model: string };

interface PromptExistente { id: number; body: string; version: string; model: string; isActive: boolean }

export type PlanoPromptPadrao =
  | { tipo: "existe"; id: number; version: string }
  | { tipo: "criar"; version: string; model: string };

/** Decisão pura: o texto já existe em alguma versão, ou vira uma versão nova. */
export function planejarPromptPadrao(existentes: PromptExistente[], bodyAtual: string): PlanoPromptPadrao {
  const body = normalizar(bodyAtual);
  const igual = existentes.find(p => normalizar(p.body) === body);
  if (igual) return { tipo: "existe", id: igual.id, version: igual.version };
  const ativo = existentes.find(p => p.isActive);
  return {
    tipo: "criar",
    // Mesmo padrão de versão do POST /sofia/prompts: v{n+1}.0.
    version: `v${existentes.length + 1}.0`,
    // Mantém o modelo que já está em uso; sem prompt ativo, vale o padrão.
    model: ativo?.model ?? DEFAULT_SOFIA_MODEL_ID,
  };
}

/**
 * Garante que o texto atual do prompt padrão (definido no código) exista no
 * banco. A publicação leva o schema, não os dados; por isso o servidor faz isso
 * ao subir, em dev e em produção.
 *
 * - Se alguma versão já tem exatamente este texto, não faz nada (nem reativa):
 *   uma escolha posterior na tela de prompts é respeitada.
 * - Senão, cria uma nova versão com o modelo do prompt ativo e a ativa.
 */
export async function ensureSofiaPromptPadrao(): Promise<ResultadoPromptPadrao> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY})`);
    const existentes = await tx.select({
      id: promptsTable.id, body: promptsTable.body, version: promptsTable.version,
      model: promptsTable.model, isActive: promptsTable.isActive,
    }).from(promptsTable);

    const plano = planejarPromptPadrao(existentes, SOFIA_PROMPT_PADRAO_BODY);
    if (plano.tipo === "existe") return { status: "ja_cadastrado", id: plano.id, version: plano.version };

    await tx.update(promptsTable).set({ isActive: false });
    const [criado] = await tx.insert(promptsTable).values({
      name: SOFIA_PROMPT_PADRAO_NOME,
      body: normalizar(SOFIA_PROMPT_PADRAO_BODY),
      version: plano.version,
      model: plano.model,
      isActive: true,
    }).returning({ id: promptsTable.id, version: promptsTable.version, model: promptsTable.model });
    return { status: "criado_e_ativado", id: criado!.id, version: criado!.version, model: criado!.model };
  });
}
