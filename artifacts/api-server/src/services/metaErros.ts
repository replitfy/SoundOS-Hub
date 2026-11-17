// Códigos de erro da Meta (WhatsApp Cloud API) que a equipe precisa entender sem abrir o painel da Meta.
// Os textos são nossos: nenhuma mensagem do provedor é copiada para o histórico, para a tela ou para os logs.

const TEXTOS: Record<number, string> = {
  131030: "Número fora da lista de teste da Meta (131030): cadastre o telefone como destinatário no painel da Meta.",
  131047: "Fora da janela de 24h do WhatsApp (131047): a pessoa não escreveu nas últimas 24 horas.",
  131026: "O número não recebe WhatsApp (131026).",
  131037: "O nome de exibição do número de WhatsApp ainda não foi aprovado pela Meta (131037): até lá, as respostas podem ser recusadas. Quem administra a conta da Meta precisa aprovar o nome de exibição.",
  190: "O token de acesso da Meta está inválido ou expirou (190): renove a conexão do WhatsApp no Hablla.",
};

/** Códigos de erro da Meta para mensagens têm seis dígitos e começam com 13 (130429, 131026, 131030, 131047...). */
const CODIGO_NO_TEXTO = /(?<![\d])13\d{4}(?![\d])/;

export function traduzirCodigoDaMeta(codigo: number): string {
  return TEXTOS[codigo] ?? `Falha da Meta, código ${codigo}.`;
}

/** Aceita número ou texto só com dígitos (o campo `code` chega dos dois jeitos). */
export function codigoDaMeta(valor: unknown): number | null {
  const texto = typeof valor === "number" ? String(valor) : typeof valor === "string" ? valor.trim() : "";
  if (!/^\d{5,7}$/.test(texto)) return null;
  const numero = Number(texto);
  return Number.isSafeInteger(numero) ? numero : null;
}

/** Procura um código da Meta dentro de um texto de erro (por exemplo "(#131030) Recipient not in allowed list"). */
export function codigoDaMetaNoTexto(texto: string | null | undefined): number | null {
  const achado = texto ? CODIGO_NO_TEXTO.exec(texto) : null;
  return achado ? Number(achado[0]) : null;
}

/** O Hablla devolve o erro da Meta como texto ("API request failed with status 400: {json}"): o código vem no campo "code". */
const CODIGO_NO_JSON = /"code"\s*:\s*"?(\d{3,7})"?/;

/**
 * Código do erro da Meta dentro do texto que o Hablla devolve. Prefere o campo "code" do JSON, porque o
 * texto também traz ids (fbtrace_id) em que uma sequência de seis dígitos pode aparecer por acaso.
 */
export function codigoDoErroEmTexto(texto: string | null | undefined): number | null {
  const doCampo = texto ? CODIGO_NO_JSON.exec(texto) : null;
  return doCampo ? Number(doCampo[1]) : codigoDaMetaNoTexto(texto);
}

/**
 * Código da Meta de uma falha já guardada (texto original com o código, ou a nossa tradução, que traz o
 * código entre parênteses, ou "Falha da Meta, código N."). Sem código reconhecível, nulo.
 */
export function codigoDaFalhaGuardada(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const direto = codigoDoErroEmTexto(texto);
  if (direto !== null) return direto;
  const achado = /\((\d{3,7})\)/.exec(texto) ?? /código (\d{3,7})\b/.exec(texto);
  return achado ? Number(achado[1]) : null;
}

/**
 * Texto de falha de envio para mostrar à equipe: quando o erro guardado traz um código da Meta, vira a
 * tradução em português (também para envios antigos); sem código, o texto segue como está.
 */
export function traduzirErroDeEnvio(texto: string | null | undefined): string | null {
  if (texto === null || texto === undefined) return null;
  const codigo = codigoDaMetaNoTexto(texto);
  return codigo === null ? texto : traduzirCodigoDaMeta(codigo);
}
