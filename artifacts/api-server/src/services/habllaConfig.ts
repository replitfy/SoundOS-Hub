import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db, habllaConfig } from "@workspace/db";
import { eq } from "drizzle-orm";

const CONFIG_ID = 1;

export type CanalDaConfig = "instagram" | "whatsapp";

export interface HabllaConfigEstado {
  instagramResponde: boolean;
  tokenConfigurado: boolean;
  tokenGeradoEm: Date | null;
  whatsappResponde: boolean;
  /** A Sofia manda o modelo de abertura a quem preenche o formulário de interesse e consentiu. */
  sofiaIniciaConversa: boolean;
  whatsappTokenConfigurado: boolean;
  whatsappTokenGeradoEm: Date | null;
}

function hashDoToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function lerLinha() {
  const [linha] = await db.select().from(habllaConfig).where(eq(habllaConfig.id, CONFIG_ID)).limit(1);
  return linha ?? null;
}

/** Sem linha = desligado e sem token (o Publish leva o schema, não os dados). */
export async function lerConfigHablla(): Promise<HabllaConfigEstado> {
  const linha = await lerLinha();
  return {
    instagramResponde: linha?.instagramResponde ?? false,
    tokenConfigurado: Boolean(linha?.webhookTokenHash),
    tokenGeradoEm: linha?.webhookTokenGeradoEm ?? null,
    whatsappResponde: linha?.whatsappResponde ?? false,
    sofiaIniciaConversa: linha?.sofiaIniciaConversa ?? false,
    whatsappTokenConfigurado: Boolean(linha?.whatsappWebhookTokenHash),
    whatsappTokenGeradoEm: linha?.whatsappWebhookTokenGeradoEm ?? null,
  };
}

export async function definirInstagramResponde(ativo: boolean): Promise<void> {
  await db.insert(habllaConfig)
    .values({ id: CONFIG_ID, instagramResponde: ativo })
    .onConflictDoUpdate({ target: habllaConfig.id, set: { instagramResponde: ativo, updatedAt: new Date() } });
}

export async function definirWhatsappResponde(ativo: boolean): Promise<void> {
  await db.insert(habllaConfig)
    .values({ id: CONFIG_ID, whatsappResponde: ativo })
    .onConflictDoUpdate({ target: habllaConfig.id, set: { whatsappResponde: ativo, updatedAt: new Date() } });
}

export async function definirSofiaIniciaConversa(ativo: boolean): Promise<void> {
  await db.insert(habllaConfig)
    .values({ id: CONFIG_ID, sofiaIniciaConversa: ativo })
    .onConflictDoUpdate({ target: habllaConfig.id, set: { sofiaIniciaConversa: ativo, updatedAt: new Date() } });
}

/**
 * Gera um token novo e guarda só o hash. O texto do token é devolvido uma única
 * vez; gerar outro invalida o anterior (o Hablla precisa receber o novo).
 * Cada canal tem o seu token: o do Instagram nunca abre o webhook do WhatsApp.
 */
async function gerarToken(canal: CanalDaConfig): Promise<{ token: string; geradoEm: Date }> {
  const token = randomBytes(32).toString("base64url");
  const geradoEm = new Date();
  const hash = hashDoToken(token);
  const campos = canal === "instagram"
    ? { webhookTokenHash: hash, webhookTokenGeradoEm: geradoEm }
    : { whatsappWebhookTokenHash: hash, whatsappWebhookTokenGeradoEm: geradoEm };
  await db.insert(habllaConfig)
    .values({ id: CONFIG_ID, ...campos })
    .onConflictDoUpdate({ target: habllaConfig.id, set: { ...campos, updatedAt: geradoEm } });
  return { token, geradoEm };
}

export function gerarTokenWebhook(): Promise<{ token: string; geradoEm: Date }> {
  return gerarToken("instagram");
}

export function gerarTokenWebhookWhatsapp(): Promise<{ token: string; geradoEm: Date }> {
  return gerarToken("whatsapp");
}

/** Extrai o token do cabeçalho, com ou sem o prefixo "Bearer". */
export function extrairTokenDoCabecalho(cabecalho: string | undefined): string | null {
  if (!cabecalho) return null;
  const valor = cabecalho.trim().replace(/^bearer\s+/i, "").trim();
  return valor === "" ? null : valor;
}

/** Comparação em tempo constante contra o hash guardado. Sem token configurado, recusa. */
async function tokenConfere(canal: CanalDaConfig, cabecalho: string | undefined): Promise<boolean> {
  const enviado = extrairTokenDoCabecalho(cabecalho);
  if (enviado === null) return false;
  const linha = await lerLinha();
  const hashGuardado = canal === "instagram" ? linha?.webhookTokenHash : linha?.whatsappWebhookTokenHash;
  if (!hashGuardado) return false;
  const esperado = Buffer.from(hashGuardado, "hex");
  const recebido = Buffer.from(hashDoToken(enviado), "hex");
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}

export function tokenDoWebhookConfere(cabecalho: string | undefined): Promise<boolean> {
  return tokenConfere("instagram", cabecalho);
}

export function tokenDoWebhookWhatsappConfere(cabecalho: string | undefined): Promise<boolean> {
  return tokenConfere("whatsapp", cabecalho);
}
