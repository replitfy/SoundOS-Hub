import { createHash } from "node:crypto";
import { codigoDaMeta, codigoDaMetaNoTexto, codigoDoErroEmTexto, traduzirCodigoDaMeta } from "./metaErros";

// Interpretador do webhook do WhatsApp (Astenir/Hablla). Diferente do Instagram, o envelope é
// documentado (https://docs.astenir.com, "WhatsApp Repacked Messages"): workspace, connection,
// meta_channel, external_id (id da Meta), sender_phone, sender_name, sender_user_id, status e
// message { type, body, is_echo }. Por isso aqui a leitura é ESTRITA e fecha pelo lado seguro:
// uma mensagem só dispara resposta quando TODAS as condições abaixo valem; qualquer outra coisa
// vira "ignorado" com um motivo que a equipe consegue ler.

export type StatusDeEntrega = "sent" | "delivered" | "read" | "failed";

export interface EsperadoWhatsapp {
  workspaceId: string | null;
  conexaoId: string | null;
}

interface Base {
  /** Id único do evento, com o canal na frente (a tabela de eventos é compartilhada com o Instagram). */
  externoId: string;
  tipoEvento: string;
}

export type TipoDeAnexoRecebido = "image" | "video" | "audio" | "document";

/** O que o aviso diz sobre um arquivo recebido. Nada aqui foi validado: quem baixa confere tudo de novo. */
export interface AnexoDoEvento {
  tipo: TipoDeAnexoRecebido;
  /** Formato declarado pelo provedor; só serve para recusar cedo, o que vale é o conteúdo. */
  mimeDeclarado: string | null;
  sha256: string | null;
  /** Endereço permanente do arquivo no provedor; `null` quando o aviso não traz. */
  url: string | null;
  /** Nome do arquivo (só documentos). */
  nome: string | null;
  /** Id da mensagem na Meta, para a mesma notificação não duplicar o arquivo. */
  metaId: string | null;
}

export type EventoWhatsapp =
  | (Base & {
    tipo: "mensagem";
    /** Só dígitos, com código do país (como a Meta envia). */
    telefone: string;
    /** Nome de perfil do WhatsApp: declarado pela própria pessoa, nunca é um nome confirmado. */
    nomePerfil: string | null;
    /** Texto da mensagem; num arquivo, a legenda (vazia quando não há). */
    texto: string;
    /** Presente quando a mensagem é imagem, vídeo, áudio ou documento. */
    anexo?: AnexoDoEvento;
  })
  | (Base & {
    tipo: "status";
    status: StatusDeEntrega;
    metaMessageId: string;
    filaId: string | null;
    erro: string | null;
  })
  | (Base & {
    tipo: "resultado_envio";
    filaId: string;
    metaMessageId: string | null;
    sucesso: boolean;
    erro: string | null;
  })
  | (Base & { tipo: "ignorado"; motivo: string });

const STATUS_DE_ENTREGA = new Set<string>(["sent", "delivered", "read", "failed"]);
const TIPOS_NAO_TEXTO = new Set([
  "image", "video", "audio", "document", "sticker", "location", "contacts", "reaction", "button",
  "interactive", "order", "system", "unsupported", "transcription", "request_welcome", "call_permission_reply",
]);
const TIPOS_DE_ANEXO = new Set<string>(["image", "video", "audio", "document"]);
const LIMITE_DA_LEGENDA = 4_000;
const EVENTOS_DE_CHAMADA = new Set(["CONNECT", "TERMINATE", "RINGING", "ACCEPTED", "ENDED"]);
const DIRECOES_DE_CHAMADA = new Set(["USER_INITIATED", "BUSINESS_INITIATED"]);
const CAMPOS_DE_CONTA = new Set([
  "account_update", "account_review_update", "account_alerts", "business_capability_update", "security",
  "history", "smb_app_state_sync", "user_preferences", "partner_solutions", "phone_number_quality_update",
  "phone_number_name_update", "message_template_status_update", "message_template_quality_update",
  "template_category_update",
]);
const TELEFONE_VALIDO = /^\d{8,15}$/;
const ID_SEGURO = /^[A-Za-z0-9._=\-:]{1,200}$/;

function objeto(valor: unknown): Record<string, unknown> | null {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

/** Telefone só com dígitos (aceita "+", espaços e hífens); `null` quando não parece um número. */
export function telefoneDoRemetente(valor: unknown): string | null {
  const bruto = texto(valor);
  if (bruto === null || !/^\+?[\d\s()-]+$/.test(bruto)) return null;
  const digitos = bruto.replace(/\D/g, "");
  return TELEFONE_VALIDO.test(digitos) ? digitos : null;
}

function idSeguro(valor: unknown): string | null {
  const id = texto(valor);
  return id !== null && ID_SEGURO.test(id) ? id : null;
}

/** A Meta informa o SHA-256 em base64 (44 caracteres); aceita-se também hexadecimal. `null` quando não parece um hash. */
export function hashEmHexadecimal(valor: string | null): string | null {
  if (valor === null) return null;
  if (/^[A-Fa-f0-9]{64}$/.test(valor)) return valor.toLowerCase();
  if (/^[A-Za-z0-9+/]{43}=$/.test(valor)) {
    const bytes = Buffer.from(valor, "base64");
    return bytes.length === 32 ? bytes.toString("hex") : null;
  }
  return null;
}

function hashDoCorpo(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/** Só letras minúsculas e "_": nunca copia um valor arbitrário do payload para o motivo. */
function rotuloSeguro(valor: unknown): string {
  const t = texto(valor)?.toLowerCase() ?? "";
  return /^[a-z_]{1,30}$/.test(t) ? t : "desconhecido";
}

function resumoDoErro(valor: unknown): string | null {
  const e = objeto(valor);
  const partes = e ? [texto(e.title), texto(e.message), texto(e.error_data), texto(e.details)] : [texto(valor)];
  const resumo = partes.filter((p): p is string => p !== null).join(": ").replace(/\s+/g, " ").slice(0, 300);
  return resumo === "" ? null : resumo;
}

/**
 * Motivo da falha de entrega lido do evento de status. Os campos variam: o envelope documentado não
 * traz o erro, mas a Meta costuma mandar `errors[]`. Quando há um código da Meta, o motivo é a nossa
 * tradução (131030 fora da lista de teste, 131047 fora da janela de 24h, 131026 número sem WhatsApp, outro
 * código = "Falha da Meta, código N"); a mensagem do provedor não é copiada.
 */
export function motivoDaFalhaDeEntrega(payload: unknown): string | null {
  const raiz = objeto(payload);
  if (!raiz) return null;
  const mensagem = objeto(raiz.message);
  const lista = [raiz.errors, mensagem?.errors].find(Array.isArray) as unknown[] | undefined;
  const erro = lista?.[0] ?? raiz.error ?? raiz.error_data ?? mensagem?.error;
  const detalhe = resumoDoErro(erro);
  const codigo = codigoDaMeta(objeto(erro)?.code ?? objeto(erro)?.error_code) ?? codigoDaMetaNoTexto(detalhe);
  if (codigo !== null) return traduzirCodigoDaMeta(codigo);
  if (detalhe !== null && /24\s*h|24 hours|re-?engage|window|janela/i.test(detalhe)) {
    return `Fora da janela de 24h do WhatsApp: a pessoa não escreveu nas últimas 24 horas (${detalhe})`.slice(0, 400);
  }
  return detalhe;
}

/** Motivo de um envio recusado pela fila: traduz o código da Meta quando existe; senão, o resumo curto. */
function motivoDoResultadoRecusado(raiz: Record<string, unknown>): string {
  const bruto = raiz.error_data ?? raiz.error ?? raiz.message;
  const resumo = resumoDoErro(bruto);
  // Na produção o erro da Meta chega só em `data`, como texto; o texto do provedor nunca é copiado.
  const dados = typeof raiz.data === "string" ? raiz.data : raiz.data === undefined ? null : JSON.stringify(raiz.data);
  const codigo = codigoDaMeta(raiz.error_code) ?? codigoDaMeta(objeto(bruto)?.code) ?? codigoDoErroEmTexto(resumo) ?? codigoDoErroEmTexto(dados);
  if (codigo !== null) return traduzirCodigoDaMeta(codigo);
  return resumo ?? "O Hablla não conseguiu enviar a mensagem.";
}

function ignorado(externoId: string, tipoEvento: string, motivo: string): EventoWhatsapp {
  return { tipo: "ignorado", externoId, tipoEvento, motivo };
}

function primeiroItem(valor: unknown): unknown {
  return Array.isArray(valor) ? valor[0] : undefined;
}

/** Id da mensagem na Meta (wamid...) dentro do resultado de um envio; os lugares prováveis, nada além. */
function metaIdDoResultado(raiz: Record<string, unknown>): string | null {
  const dados = objeto(raiz.data);
  const resposta = objeto(raiz.response);
  const candidatos = [
    raiz.external_id, raiz.wamid, raiz.meta_message_id,
    dados?.external_id, dados?.wamid,
    objeto(primeiroItem(resposta?.messages))?.id,
    objeto(primeiroItem(dados?.messages))?.id,
  ];
  for (const candidato of candidatos) {
    const id = idSeguro(candidato);
    if (id !== null && id.startsWith("wamid")) return id;
  }
  return null;
}

export function interpretarEventoWhatsapp(payload: unknown, esperado: EsperadoWhatsapp): EventoWhatsapp {
  const raiz = objeto(payload);
  const corpo = hashDoCorpo(payload);
  if (!raiz) return ignorado(`whatsapp:sha256:${corpo}`, "desconhecido", "formato_invalido");

  const nomeDoEvento = texto(raiz.event) ?? texto(raiz.type);
  const tipoEvento = nomeDoEvento && /^[A-Za-z0-9._:-]{1,80}$/.test(nomeDoEvento) ? nomeDoEvento : "whatsapp";
  const mensagem = objeto(raiz.message);
  const externo = idSeguro(raiz.external_id);
  const statusBruto = texto(raiz.status)?.toLowerCase() ?? null;
  const nomeEmMinusculas = nomeDoEvento?.toLowerCase() ?? "";
  const fallback = (prefixo: string) => `whatsapp:${prefixo}:sha256:${corpo}`;

  if (!esperado.workspaceId || !esperado.conexaoId) return ignorado(fallback("evento"), tipoEvento, "canal_nao_configurado");

  // Eventos de outro workspace/conexão nunca são nossos. Para mensagens, a ausência também recusa
  // (abaixo); só os eventos de entrega/resultado de envio toleram a ausência dos dois campos.
  const workspace = texto(raiz.workspace);
  const conexao = texto(raiz.connection);
  if (workspace !== null && workspace !== esperado.workspaceId) return ignorado(fallback("evento"), tipoEvento, "outro_workspace");
  if (conexao !== null && conexao !== esperado.conexaoId) return ignorado(fallback("evento"), tipoEvento, "outra_conexao");

  const canalDaMeta = texto(raiz.meta_channel)?.toLowerCase();
  if (canalDaMeta !== undefined && canalDaMeta !== "whatsapp") return ignorado(fallback("evento"), tipoEvento, "outro_canal");

  // Chamadas de voz, eventos de conta e de modelo de mensagem.
  const eventoDeChamada = texto(raiz.event) !== null && EVENTOS_DE_CHAMADA.has(texto(raiz.event)!.toUpperCase());
  if (nomeEmMinusculas.startsWith("whatsapp.call") || eventoDeChamada || DIRECOES_DE_CHAMADA.has(String(raiz.direction).toUpperCase())
    || objeto(raiz.session)?.sdp !== undefined || texto(raiz.call_id) !== null) {
    return ignorado(fallback("chamada"), tipoEvento, "chamada_de_voz");
  }
  const campo = texto(raiz.field)?.toLowerCase();
  const nomeSemPrefixo = nomeEmMinusculas.replace(/^whatsapp\./, "");
  if ((campo !== undefined && CAMPOS_DE_CONTA.has(campo)) || CAMPOS_DE_CONTA.has(nomeSemPrefixo)
    || (nomeEmMinusculas.startsWith("astenir.") && !nomeEmMinusculas.includes("whatsapp.message_send"))) {
    return ignorado(fallback("conta"), tipoEvento, "evento_de_conta");
  }

  // Resultado do envio feito por nós (astenir.meta_api.whatsapp.message_send): liga a fila à mensagem da Meta.
  const filaId = idSeguro(raiz.task_id);
  if (nomeEmMinusculas.includes("message_send") || (filaId !== null && (statusBruto === "success" || statusBruto === "error" || statusBruto === "partial_error"))) {
    if (filaId === null) return ignorado(fallback("envio"), tipoEvento, "resultado_de_envio_sem_fila");
    const sucesso = statusBruto === "success" || statusBruto === "partial_error";
    return {
      tipo: "resultado_envio",
      externoId: `whatsapp:envio:${filaId}:${statusBruto ?? "sem_status"}`,
      tipoEvento,
      filaId,
      metaMessageId: metaIdDoResultado(raiz),
      sucesso,
      erro: sucesso ? null : motivoDoResultadoRecusado(raiz),
    };
  }

  // Atualização de entrega: o id do evento inclui o próprio status (o mesmo id da Meta tem vários).
  if (statusBruto !== null) {
    if (!STATUS_DE_ENTREGA.has(statusBruto)) return ignorado(fallback("status"), tipoEvento, "status_desconhecido");
    if (externo === null) return ignorado(fallback("status"), tipoEvento, "status_sem_id_da_mensagem");
    return {
      tipo: "status",
      externoId: `whatsapp:status:${statusBruto}:${externo}`,
      tipoEvento,
      status: statusBruto as StatusDeEntrega,
      metaMessageId: externo,
      filaId,
      erro: statusBruto === "failed" ? motivoDaFalhaDeEntrega(payload) : null,
    };
  }

  const idDoEvento = externo !== null ? `whatsapp:msg:${externo}` : fallback("msg");

  // Eco de mensagem enviada pela própria conta (aplicativo do WhatsApp Business).
  if (mensagem?.is_echo === true || raiz.is_echo === true || campo === "smb_message_echoes" || nomeEmMinusculas.includes("echo")) {
    return ignorado(idDoEvento, tipoEvento, "mensagem_enviada_pela_conta");
  }
  if (mensagem === null) return ignorado(idDoEvento, tipoEvento, "evento_sem_mensagem");

  const tipoDaMensagem = texto(mensagem.type)?.toLowerCase() ?? null;
  if (tipoDaMensagem === null) return ignorado(idDoEvento, tipoEvento, "mensagem_sem_tipo");
  const ehAnexo = TIPOS_DE_ANEXO.has(tipoDaMensagem);
  if (tipoDaMensagem !== "text" && !ehAnexo) {
    return ignorado(idDoEvento, tipoEvento, TIPOS_NAO_TEXTO.has(tipoDaMensagem) ? `mensagem_sem_texto:${tipoDaMensagem}` : `mensagem_sem_texto:${rotuloSeguro(tipoDaMensagem)}`);
  }

  // A partir daqui é uma mensagem de cliente: só responde com workspace e conexão presentes e iguais.
  if (workspace === null || conexao === null) return ignorado(idDoEvento, tipoEvento, "workspace_ou_conexao_ausente");

  const corpoDoTexto = ehAnexo
    ? (typeof mensagem.caption === "string" ? mensagem.caption : "")
    : (typeof mensagem.body === "string" ? mensagem.body : null);
  if (!ehAnexo && (corpoDoTexto === null || corpoDoTexto.trim() === "")) return ignorado(idDoEvento, tipoEvento, "texto_vazio");

  const telefone = telefoneDoRemetente(raiz.sender_phone);
  if (telefone === null) {
    return ignorado(idDoEvento, tipoEvento, texto(raiz.sender_user_id) !== null ? "remetente_sem_telefone" : "telefone_invalido");
  }

  const anexo: AnexoDoEvento | undefined = ehAnexo
    ? {
      tipo: tipoDaMensagem as TipoDeAnexoRecebido,
      mimeDeclarado: texto(mensagem.mime_type),
      sha256: hashEmHexadecimal(texto(mensagem.sha256)),
      url: texto(mensagem.url),
      nome: tipoDaMensagem === "document" ? texto(mensagem.filename) : null,
      metaId: externo,
    }
    : undefined;

  return {
    tipo: "mensagem",
    externoId: idDoEvento,
    tipoEvento,
    telefone,
    nomePerfil: texto(raiz.sender_name) && texto(raiz.sender_name)!.toLowerCase() !== "unknown" ? texto(raiz.sender_name)!.slice(0, 120) : null,
    texto: (corpoDoTexto ?? "").trim().slice(0, ehAnexo ? LIMITE_DA_LEGENDA : undefined),
    ...(anexo ? { anexo } : {}),
  };
}
