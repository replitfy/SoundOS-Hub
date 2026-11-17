import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { conversations, db, type ConversationCanal } from "@workspace/db";
import { contarRespostasNaoEntregues } from "./falhasDeEnvio";

// Conversas de canais externos (WhatsApp, Instagram) que pedem a atenção da equipe. Duas origens, as duas
// derivadas dos dados (sem estado próprio de aviso): a Sofia passou a conversa para a equipe e ninguém
// assumiu (status), ou a pessoa mandou um arquivo pelo WhatsApp que ninguém da equipe viu ainda
// (mensagem_anexos.visto_em vazio, qualquer status da conversa). A conversa conta uma vez só, mesmo com as
// duas origens, e o aviso some sozinho quando alguém assume/resolve ou abre a conversa (os arquivos passam a vistos).
// O chat interno do SoundOS (testes da equipe) fica de fora: quem testa já está olhando a conversa.
// O resumo traz também, em separado, quantas conversas externas têm a última resposta da Sofia não entregue
// (falha de envio): é outro problema, com outra ação, e nunca entra no total de "aguardando a equipe".

const LIMITE_DA_LISTA = 20;

export interface ConversaAguardandoEquipe {
  id: number;
  title: string;
  canal: Exclude<ConversationCanal, "interno">;
  canalUsuario: string | null;
  waitingSince: string;
  /** Arquivos recebidos que ninguém da equipe viu ainda (0 quando o aviso é só do handoff). */
  arquivosNaoVistos: number;
}

export interface ResumoAguardandoEquipe {
  total: number;
  /** Conversas de canais externos cuja última resposta da Sofia não foi entregue. Independe de `total`. */
  respostasNaoEntregues: number;
  oldestWaitingSince: string | null;
  conversations: ConversaAguardandoEquipe[];
}

// Subconsultas correlacionadas com nomes explícitos: colunas interpoladas perderiam a qualificação da tabela.
const ARQUIVO_NAO_VISTO = sql`FROM mensagem_anexos a WHERE a.conversation_id = conversations.id AND a.direcao = 'recebido' AND a.visto_em IS NULL AND conversations.canal = 'whatsapp'`;

function filtro() {
  return and(
    ne(conversations.canal, "interno"),
    eq(conversations.hidden, false),
    or(eq(conversations.status, "aguardando_humano"), sql`EXISTS (SELECT 1 ${ARQUIVO_NAO_VISTO})`),
  );
}

/** Desde quando a equipe é esperada: o mais antigo entre o handoff (conversas antigas contam desde a criação) e o primeiro arquivo não visto. */
function aguardandoDesde() {
  return sql`LEAST(
    CASE WHEN ${conversations.status} = 'aguardando_humano' THEN COALESCE(${conversations.handoffTriggeredAt}, ${conversations.createdAt}) END,
    (SELECT MIN(a.created_at) ${ARQUIVO_NAO_VISTO})
  )`;
}

export async function resumirConversasAguardandoEquipe(): Promise<ResumoAguardandoEquipe> {
  const desdeSql = aguardandoDesde();
  const colunas = {
    id: conversations.id,
    title: conversations.title,
    canal: conversations.canal,
    canalUsuario: conversations.canalUsuario,
    desde: sql<Date>`${desdeSql}`.as("desde"),
    arquivosNaoVistos: sql<number>`(SELECT COUNT(*)::int ${ARQUIVO_NAO_VISTO})`.as("arquivos_nao_vistos"),
  };
  const [[contagem], recentes, [maisAntiga], respostasNaoEntregues] = await Promise.all([
    db.select({ total: sql<number>`COUNT(*)::int` }).from(conversations).where(filtro()),
    db.select(colunas).from(conversations).where(filtro()).orderBy(desc(desdeSql), desc(conversations.id)).limit(LIMITE_DA_LISTA),
    db.select(colunas).from(conversations).where(filtro()).orderBy(asc(desdeSql), asc(conversations.id)).limit(1),
    contarRespostasNaoEntregues(),
  ]);

  const iso = (valor: Date | string) => new Date(valor).toISOString();
  return {
    total: contagem?.total ?? 0,
    respostasNaoEntregues,
    oldestWaitingSince: maisAntiga ? iso(maisAntiga.desde) : null,
    conversations: recentes.map(c => ({
      id: c.id,
      title: c.title,
      canal: c.canal as ConversaAguardandoEquipe["canal"],
      canalUsuario: c.canalUsuario,
      waitingSince: iso(c.desde),
      arquivosNaoVistos: c.arquivosNaoVistos,
    })),
  };
}
