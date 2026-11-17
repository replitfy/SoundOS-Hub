// Cliente da API da Astenir, a plataforma por trás do Hablla (https://docs.astenir.com).
// O token guardado é um token de usuário de sistema da Astenir: só vale em api.astenir.com
// e só no workspace a que pertence (outros recebem 401). Rotas por workspace no singular:
// /v1/workspace/{workspace}/...
//
// Um único envio por mensagem, sem repetição automática — uma resposta duplicada para o
// cliente é pior do que uma falha visível à equipe. O HTTP 202 do envio quer dizer só
// "aceito na fila"; a entrega chega depois por webhook.
//
// Conexões (Instagram, WhatsApp) são sempre escolhidas por ID explícito de configuração.
// O workspace tem mais de uma conta de Instagram: adivinhar por nome ou tipo mandaria a
// resposta pela conta errada.

export type CanalHablla = "instagram" | "whatsapp";

export type CodigoErroHablla =
  | "sem_credenciais"
  | "nao_autorizado"
  | "sem_permissao"
  | "conexao_nao_encontrada"
  | "conexao_tipo_errado"
  | "conexao_inativa"
  | "janela_24h"
  | "http"
  | "rede";

export class HabllaErro extends Error {
  constructor(public readonly codigo: CodigoErroHablla, mensagem: string, public readonly status?: number) {
    super(mensagem);
    this.name = "HabllaErro";
  }
}

export interface HabllaClientDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const BASE_URL_PADRAO = "https://api.astenir.com";
const TIMEOUT_MS = 15_000;
const CACHE_CONEXAO_MS = 10 * 60 * 1000;

const CANAIS: Record<CanalHablla, { variavel: string; escopo: string; rotulo: string }> = {
  instagram: { variavel: "HABLLA_INSTAGRAM_CONNECTION_ID", escopo: "INSTAGRAM", rotulo: "Instagram" },
  whatsapp: { variavel: "HABLLA_WHATSAPP_CONNECTION_ID", escopo: "WHATSAPP_MESSAGING", rotulo: "WhatsApp" },
};

export interface ConexaoHablla {
  id: string;
  nome: string | null;
  /**
   * Conexão de WhatsApp em número de teste da Meta. Vem do nome do negócio que o Hablla guarda na conexão
   * (o número de teste da Meta se chama "Test Number"). Ausente quando a conexão não informa o nome.
   */
  numeroDeTeste?: boolean;
}

const NOME_DO_NUMERO_DE_TESTE_DA_META = "test number";

// Só guarda conexões já conferidas com sucesso; falha nunca fica em cache.
const conexoesConferidas = new Map<string, { conexao: ConexaoHablla; ate: number }>();

export function limparCacheHablla(): void {
  conexoesConferidas.clear();
}

function credenciais(env: NodeJS.ProcessEnv) {
  const token = env.HABLLA_API_TOKEN?.trim();
  const workspaceId = env.HABLLA_WORKSPACE_ID?.trim();
  if (!token || !workspaceId) {
    throw new HabllaErro("sem_credenciais", "Faltam HABLLA_API_TOKEN ou HABLLA_WORKSPACE_ID.");
  }
  return { token, workspaceId, baseUrl: (env.HABLLA_API_URL?.trim() || BASE_URL_PADRAO).replace(/\/+$/, "") };
}

/** ID da conexão do canal vindo da configuração; `null` quando não foi definido. */
export function idDaConexaoConfigurada(canal: CanalHablla, env: NodeJS.ProcessEnv = process.env): string | null {
  return env[CANAIS[canal].variavel]?.trim() || null;
}

/** Token, workspace e ID da conexão do canal presentes. Não prova que são válidos: veja verificarCredenciaisHablla. */
export function credenciaisHabllaConfiguradas(canal: CanalHablla = "instagram", env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HABLLA_API_TOKEN?.trim() && env.HABLLA_WORKSPACE_ID?.trim() && idDaConexaoConfigurada(canal, env));
}

/** Caminho de uma rota do workspace configurado, ex.: caminhoDoWorkspace(ws, "/connection"). */
export function caminhoDoWorkspace(workspaceId: string, resto: string): string {
  return `/v1/workspace/${encodeURIComponent(workspaceId)}${resto}`;
}

/** Camada de transporte comum: autenticação, timeout e erros tipados. Não repete nenhuma chamada. */
export async function chamarHablla(
  caminho: string,
  init: { method: "GET" | "POST"; corpo?: unknown; multipart?: FormData; timeoutMs?: number },
  deps: HabllaClientDeps = {},
): Promise<{ status: number; texto: string; json: unknown }> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const { token, baseUrl } = credenciais(env);

  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), init.timeoutMs ?? TIMEOUT_MS);
  let resultado: { status: number; texto: string; json: unknown };
  try {
    // Multipart: o fetch define o Content-Type com a fronteira; fixar "application/json" quebraria o envio.
    const resposta = await doFetch(`${baseUrl}${caminho}`, {
      method: init.method,
      headers: init.multipart
        ? { authorization: `Bearer ${token}`, accept: "application/json" }
        : { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: init.multipart ?? (init.corpo === undefined ? undefined : JSON.stringify(init.corpo)),
      signal: controle.signal,
    });
    const texto = await resposta.text();
    let json: unknown = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { json = null; }
    resultado = { status: resposta.status, texto, json };
  } catch (error) {
    throw new HabllaErro("rede", `Falha de rede ao falar com o Hablla: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (resultado.status === 401) {
    throw new HabllaErro(
      "nao_autorizado",
      "O Hablla recusou o token (HTTP 401): o token está errado ou pertence a outro workspace.",
      401,
    );
  }
  if (resultado.status === 403) {
    throw new HabllaErro(
      "sem_permissao",
      "O Hablla negou a permissão (HTTP 403): o usuário de sistema não pode executar esta ação. Peça a um administrador do Hablla para liberar.",
      403,
    );
  }
  return resultado;
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

/** Resumo curto do erro: usa `message` e `error_data` do formato de erro da Astenir, ou o corpo cru. */
export function resumoDoErro(resposta: { texto: string; json: unknown }): string {
  const erro = objeto(resposta.json);
  const partes = erro ? [texto(erro.message), texto(erro.error_data)].filter((p): p is string => p !== null) : [];
  const base = partes.length > 0 ? partes.join(": ") : resposta.texto;
  return base.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Confere uma conexão pelo ID configurado: ela precisa existir neste workspace, ser do tipo do canal e
 * estar ativa. Sucesso fica em cache por alguns minutos; falha lança e não é guardada.
 */
export async function conferirConexao(
  canal: CanalHablla,
  deps: HabllaClientDeps = {},
  opcoes: { ignorarCache?: boolean } = {},
): Promise<ConexaoHablla> {
  const env = deps.env ?? process.env;
  const { workspaceId, baseUrl } = credenciais(env);
  const { variavel, escopo, rotulo } = CANAIS[canal];
  const conexaoId = idDaConexaoConfigurada(canal, env);
  if (!conexaoId) throw new HabllaErro("sem_credenciais", `Falta ${variavel} (ID da conexão de ${rotulo} no Hablla).`);

  const chave = `${baseUrl}|${workspaceId}|${canal}|${conexaoId}`;
  const emCache = conexoesConferidas.get(chave);
  if (!opcoes.ignorarCache && emCache && emCache.ate > Date.now()) return emCache.conexao;

  const resposta = await chamarHablla(caminhoDoWorkspace(workspaceId, `/connection/${encodeURIComponent(conexaoId)}`), { method: "GET" }, deps);
  if (resposta.status === 404) {
    throw new HabllaErro("conexao_nao_encontrada", `A conexão de ${rotulo} (${variavel}) não existe neste workspace do Hablla.`, 404);
  }
  if (resposta.status >= 400) {
    throw new HabllaErro("http", `Não consegui conferir a conexão de ${rotulo} (HTTP ${resposta.status}): ${resumoDoErro(resposta)}`, resposta.status);
  }
  // Nunca devolver nem registrar o corpo inteiro: a conexão traz credenciais e webhooks.
  const dados = objeto(resposta.json);
  const idRecebido = dados ? texto(dados.id) ?? texto(dados._id) : null;
  const workspaceRecebido = dados ? texto(dados.workspace) : null;
  if (!dados || idRecebido !== conexaoId || (workspaceRecebido !== null && workspaceRecebido !== workspaceId)) {
    throw new HabllaErro("conexao_nao_encontrada", `A conexão de ${rotulo} (${variavel}) não pertence a este workspace do Hablla.`);
  }
  const escopoRecebido = texto(dados.scope);
  if (escopoRecebido?.toUpperCase() !== escopo) {
    throw new HabllaErro("conexao_tipo_errado", `A conexão configurada em ${variavel} não é de ${rotulo} (tipo ${escopoRecebido ?? "desconhecido"}).`);
  }
  const status = texto(dados.status);
  if (status !== null && status.toLowerCase() !== "active") {
    throw new HabllaErro("conexao_inativa", `A conexão de ${rotulo} não está ativa no Hablla (status ${status}).`);
  }
  const nomeDoNegocio = texto(objeto(dados.additional_info)?.whatsapp_business_name);
  const conexao: ConexaoHablla = {
    id: conexaoId,
    nome: texto(dados.name),
    ...(nomeDoNegocio !== null ? { numeroDeTeste: nomeDoNegocio.trim().toLowerCase() === NOME_DO_NUMERO_DE_TESTE_DA_META } : {}),
  };
  conexoesConferidas.set(chave, { conexao, ate: Date.now() + CACHE_CONEXAO_MS });
  return conexao;
}

/** ID da fila devolvido no aceite do envio (HTTP 202). Não é o ID da mensagem. */
export function idDoAceite(json: unknown): string | null {
  const dados = objeto(json);
  if (!dados) return null;
  const id = dados.task_id ?? dados.id ?? dados._id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

// A Meta só permite responder até 24h depois da última mensagem do cliente. A Astenir não publica um
// código próprio para isso; com o ID cru do contato a recusa costuma chegar depois, por webhook.
// Se vier na resposta síncrona, reconhecemos pelo texto.
// O catálogo de erros da Astenir (GET /error-codes) tem o código 126, "The service session is closed —
// send a template to re-engage the customer", que é a recusa por janela fechada quando o envio usa um
// lead/atendimento. Com o telefone cru a recusa pode vir só depois, como status "failed" no webhook.
const CODIGOS_JANELA_FECHADA = new Set([126]);
const JANELA_24H = /24\s*h|24 hours|24 horas|janela|window|session (is )?closed|re-?engage|outside.*(allowed|messaging)|expired|expirad/i;

/** Transforma uma resposta de envio recusada em erro tipado. */
export function erroDeEnvioRecusado(canal: CanalHablla, resposta: { status: number; texto: string; json: unknown }): HabllaErro {
  const detalhe = resumoDoErro(resposta);
  const codigo = Number(objeto(resposta.json)?.error_code);
  if (CODIGOS_JANELA_FECHADA.has(codigo) || JANELA_24H.test(detalhe)) {
    return new HabllaErro("janela_24h", `Fora da janela de 24h do ${CANAIS[canal].rotulo}: ${detalhe}`, resposta.status);
  }
  return new HabllaErro("http", `O Hablla recusou o envio (HTTP ${resposta.status}): ${detalhe}`, resposta.status);
}

/**
 * Envia uma DM de texto pelo Instagram. Lança HabllaErro em qualquer falha.
 * `externoId` é o ID da fila de envio: o Hablla só aceitou, ainda não entregou.
 */
export async function enviarMensagemInstagram(
  entrada: { para: string; texto: string },
  deps: HabllaClientDeps = {},
): Promise<{ externoId: string | null }> {
  const env = deps.env ?? process.env;
  const { workspaceId } = credenciais(env);
  const conexao = await conferirConexao("instagram", deps);
  const caminho = caminhoDoWorkspace(workspaceId, `/meta/connection/${encodeURIComponent(conexao.id)}/instagram-messaging/messages/send`);
  const resposta = await chamarHablla(caminho, { method: "POST", corpo: { instagram_id: entrada.para, text: entrada.texto } }, deps);

  if (resposta.status >= 200 && resposta.status < 300) return { externoId: idDoAceite(resposta.json) };
  throw erroDeEnvioRecusado("instagram", resposta);
}

/**
 * Envia uma mensagem de texto do WhatsApp (rota JSON da Astenir, `type: "text"`). Lança HabllaErro em
 * qualquer falha. Uma única tentativa: o 202 quer dizer "aceito na fila" (nunca "entregue") e o
 * `task_id` devolvido é o id da fila, não o da mensagem. Fora da janela de 24h a Astenir recusa; nós
 * NÃO trocamos por modelo de mensagem nem por outro texto: a equipe precisa ver a falha.
 * `para` é o telefone com código do país, só dígitos.
 */
export async function enviarMensagemWhatsapp(
  entrada: { para: string; texto: string },
  deps: HabllaClientDeps = {},
): Promise<{ externoId: string | null }> {
  const env = deps.env ?? process.env;
  const { workspaceId } = credenciais(env);
  const conexao = await conferirConexao("whatsapp", deps);
  const caminho = caminhoDoWorkspace(workspaceId, `/meta/connection/${encodeURIComponent(conexao.id)}/whatsapp-messaging/messages/send`);
  const resposta = await chamarHablla(caminho, { method: "POST", corpo: { type: "text", phone: entrada.para, body: entrada.texto } }, deps);

  if (resposta.status >= 200 && resposta.status < 300) return { externoId: idDoAceite(resposta.json) };
  throw erroDeEnvioRecusado("whatsapp", resposta);
}

const TEMPO_DO_ENVIO_DE_ARQUIVO_MS = 120_000;

/**
 * Envia uma imagem, vídeo, áudio ou documento do WhatsApp (rota `messages/send` da Astenir em multipart:
 * `type`, `phone`, `file`, `caption` e `filename` para documentos). Uma única tentativa, como no texto: o 202
 * quer dizer "aceito na fila", nunca "entregue". Áudio não aceita legenda. Lança HabllaErro em qualquer falha.
 * `para` é o telefone com código do país, só dígitos.
 */
export async function enviarAnexoWhatsapp(
  entrada: { para: string; tipo: "image" | "video" | "audio" | "document"; arquivo: Blob; mime: string; nome: string; legenda?: string | null },
  deps: HabllaClientDeps = {},
): Promise<{ externoId: string | null }> {
  const env = deps.env ?? process.env;
  const { workspaceId } = credenciais(env);
  const conexao = await conferirConexao("whatsapp", deps);
  const caminho = caminhoDoWorkspace(workspaceId, `/meta/connection/${encodeURIComponent(conexao.id)}/whatsapp-messaging/messages/send`);
  const formulario = new FormData();
  formulario.set("type", entrada.tipo);
  formulario.set("phone", entrada.para);
  formulario.set("file", entrada.arquivo.slice(0, entrada.arquivo.size, entrada.mime), entrada.nome);
  if (entrada.legenda && entrada.tipo !== "audio") formulario.set("caption", entrada.legenda);
  if (entrada.tipo === "document") formulario.set("filename", entrada.nome);
  const resposta = await chamarHablla(caminho, { method: "POST", multipart: formulario, timeoutMs: TEMPO_DO_ENVIO_DE_ARQUIVO_MS }, deps);
  if (resposta.status >= 200 && resposta.status < 300) return { externoId: idDoAceite(resposta.json) };
  throw erroDeEnvioRecusado("whatsapp", resposta);
}

/** Um modelo de mensagem do WhatsApp, como a Astenir o lista (só o que o envio precisa). */
export interface ModeloWhatsapp {
  id: string;
  nome: string;
  idioma: string;
  /** PENDING, APPROVED, REJECTED, PAUSED... (como a Meta informa). */
  status: string;
  /** Texto dos componentes do modelo (corpo e, se houver, cabeçalho), com as variáveis {{1}}. */
  corpo: string | null;
  cabecalho: string | null;
}

/**
 * Lista os modelos da conexão do WhatsApp (somente leitura). Procura nas primeiras páginas até achar
 * `nome`/`idioma`; devolve `null` quando o modelo não existe na conta.
 */
export async function buscarModeloWhatsapp(
  filtro: { nome: string; idioma: string },
  deps: HabllaClientDeps = {},
): Promise<ModeloWhatsapp | null> {
  const env = deps.env ?? process.env;
  const { workspaceId } = credenciais(env);
  const conexao = await conferirConexao("whatsapp", deps);
  const base = caminhoDoWorkspace(workspaceId, `/meta/connection/${encodeURIComponent(conexao.id)}/whatsapp-messaging/templates`);
  for (let pagina = 1; pagina <= 5; pagina += 1) {
    const resposta = await chamarHablla(`${base}?page=${pagina}`, { method: "GET" }, deps);
    if (resposta.status >= 400) {
      throw new HabllaErro("http", `Não consegui consultar os modelos do WhatsApp (HTTP ${resposta.status}): ${resumoDoErro(resposta)}`, resposta.status);
    }
    const resultados = objeto(resposta.json)?.results;
    if (!Array.isArray(resultados) || resultados.length === 0) return null;
    for (const item of resultados) {
      const modelo = objeto(item);
      if (!modelo || modelo.name !== filtro.nome || modelo.language !== filtro.idioma) continue;
      const componentes = Array.isArray(modelo.components) ? modelo.components.map(objeto) : [];
      const textoDe = (tipo: string) => texto(componentes.find(c => c?.type === tipo)?.text);
      const id = texto(modelo.id) ?? texto(modelo._id);
      if (!id) return null;
      return { id, nome: filtro.nome, idioma: filtro.idioma, status: texto(modelo.status) ?? "UNKNOWN", corpo: textoDe("BODY"), cabecalho: textoDe("HEADER") };
    }
  }
  return null;
}

/**
 * Envia um modelo aprovado (rota `templates/send` da Astenir). Uma única tentativa, sem repetir: o 202 quer
 * dizer "aceito na fila", nunca "entregue". Com usuário de sistema a Astenir não abre atendimento para o
 * modelo. `variaveis` usa a posição como chave ("1" para {{1}}). Lança HabllaErro em qualquer falha.
 */
export async function enviarModeloWhatsapp(
  entrada: { para: string; modeloId: string; variaveis: Record<string, string> },
  deps: HabllaClientDeps = {},
): Promise<{ externoId: string | null }> {
  const env = deps.env ?? process.env;
  const { workspaceId } = credenciais(env);
  const conexao = await conferirConexao("whatsapp", deps);
  const caminho = caminhoDoWorkspace(workspaceId, `/meta/connection/${encodeURIComponent(conexao.id)}/whatsapp-messaging/templates/send`);
  const resposta = await chamarHablla(caminho, {
    method: "POST",
    corpo: { template_id: entrada.modeloId, phone: entrada.para, variables: entrada.variaveis },
  }, deps);
  if (resposta.status >= 200 && resposta.status < 300) return { externoId: idDoAceite(resposta.json) };
  throw erroDeEnvioRecusado("whatsapp", resposta);
}

// ── Verificação de credenciais (somente leitura) ─────────────────────────────

export type EstadoTokenHablla = "ok" | "sem_credenciais" | "recusado" | "workspace_diferente" | "indisponivel";
export type EstadoConexaoHablla =
  | "ok" | "nao_configurada" | "nao_verificada" | "nao_encontrada" | "tipo_errado" | "inativa" | "indisponivel";

export interface VerificacaoHablla {
  token: EstadoTokenHablla;
  conexoes: Record<CanalHablla, { estado: EstadoConexaoHablla; nome: string | null; numeroDeTeste?: boolean }>;
  /** Nome e tipo das conexões do workspace, sem IDs, credenciais nem webhooks. */
  conexoesNoWorkspace: Array<{ nome: string; tipo: string | null }>;
}

function estadoDaFalhaDeConexao(erro: unknown): EstadoConexaoHablla {
  if (erro instanceof HabllaErro) {
    if (erro.codigo === "conexao_nao_encontrada") return "nao_encontrada";
    if (erro.codigo === "conexao_tipo_errado") return "tipo_errado";
    if (erro.codigo === "conexao_inativa") return "inativa";
  }
  return "indisponivel";
}

/**
 * Consulta só leitura: o token é aceito neste workspace? As conexões configuradas existem, são do tipo
 * certo e estão ativas? Devolve apenas estados e nomes de exibição — nunca segredos, IDs de usuário ou telefones.
 */
export async function verificarCredenciaisHablla(deps: HabllaClientDeps = {}): Promise<VerificacaoHablla> {
  const env = deps.env ?? process.env;
  const canais = Object.keys(CANAIS) as CanalHablla[];
  const semVerificar = (token: EstadoTokenHablla): VerificacaoHablla => ({
    token,
    conexoes: Object.fromEntries(canais.map(canal => [
      canal,
      { estado: idDaConexaoConfigurada(canal, env) ? "nao_verificada" : "nao_configurada", nome: null },
    ])) as VerificacaoHablla["conexoes"],
    conexoesNoWorkspace: [],
  });

  let workspaceId: string;
  try {
    workspaceId = credenciais(env).workspaceId;
  } catch {
    return semVerificar("sem_credenciais");
  }

  try {
    const eu = await chamarHablla(caminhoDoWorkspace(workspaceId, "/me"), { method: "GET" }, deps);
    if (eu.status >= 400) return semVerificar("indisponivel");
    const workspaceDoToken = objeto(eu.json) ? texto(objeto(eu.json)!.workspace) : null;
    if (workspaceDoToken !== null && workspaceDoToken !== workspaceId) return semVerificar("workspace_diferente");
  } catch (erro) {
    if (erro instanceof HabllaErro && (erro.codigo === "nao_autorizado" || erro.codigo === "sem_permissao")) {
      return semVerificar("recusado");
    }
    return semVerificar("indisponivel");
  }

  const listar = async (): Promise<VerificacaoHablla["conexoesNoWorkspace"]> => {
    try {
      const resposta = await chamarHablla(caminhoDoWorkspace(workspaceId, "/connection"), { method: "GET" }, deps);
      const lista = objeto(resposta.json)?.results;
      if (resposta.status >= 400 || !Array.isArray(lista)) return [];
      return lista.flatMap(item => {
        const c = objeto(item);
        const nome = c ? texto(c.name) : null;
        return nome ? [{ nome, tipo: texto(c!.scope) }] : [];
      });
    } catch {
      return [];
    }
  };

  const conferir = async (canal: CanalHablla): Promise<VerificacaoHablla["conexoes"][CanalHablla]> => {
    if (!idDaConexaoConfigurada(canal, env)) return { estado: "nao_configurada", nome: null };
    try {
      const conexao = await conferirConexao(canal, deps, { ignorarCache: true });
      return { estado: "ok", nome: conexao.nome, ...(conexao.numeroDeTeste !== undefined ? { numeroDeTeste: conexao.numeroDeTeste } : {}) };
    } catch (erro) {
      return { estado: estadoDaFalhaDeConexao(erro), nome: null };
    }
  };

  const [conexoesNoWorkspace, instagram, whatsapp] = await Promise.all([listar(), conferir("instagram"), conferir("whatsapp")]);
  return { token: "ok", conexoes: { instagram, whatsapp }, conexoesNoWorkspace };
}
