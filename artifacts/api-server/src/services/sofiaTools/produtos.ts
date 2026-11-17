import {
  getPublicProductFacts,
  getPublishedCatalog,
  matchPublishedProducts,
  type CatalogProduct,
} from "../wixCatalog.js";

/**
 * Ferramentas de produto do modo simples da Sofia.
 *
 * Tudo é derivado do catálogo publicado (Wix + disponibilidade qualitativa do
 * Omie). Nada aqui devolve quantidade de estoque nem descrição gerada por IA,
 * e a URL só vem de `CatalogProduct.url`.
 */

export type Disponibilidade = "disponivel" | "indisponivel" | "indeterminada";
export type TipoMatch = "exato" | "familia" | "similar" | "nenhum" | "erro";

export interface ProdutoSofia {
  id: string;
  sku: string | null;
  nome: string;
  descricao_curta: string | null;
  preco: number | null;
  preco_max: number | null;
  moeda: string;
  disponibilidade: Disponibilidade;
  url: string | null;
  motivo_match: string;
}

export interface ResultadoProdutos {
  tipo_match: TipoMatch;
  produtos: ProdutoSofia[];
  instrucao?: string;
}

export interface BuscarProdutoInput {
  consulta: string;
  uso?: string | null;
  categoria?: string | null;
  preco_max?: number | null;
  limite?: number | null;
}

export interface ProdutosSimilaresInput {
  produto_id?: string | null;
  sku?: string | null;
  nome?: string | null;
  limite?: number | null;
}

const LIMITE_PADRAO = 3;
const LIMITE_MAXIMO = 5;

export const INSTRUCAO_SIMILAR =
  "Diga que não encontrou exatamente o pedido e apresente estes itens como parecidos, nunca como se fossem o mesmo produto.";
const INSTRUCAO_NENHUM =
  "Não há produto parecido no catálogo publicado. Diga isso com honestidade e não invente item, preço ou link.";
const INSTRUCAO_ERRO =
  "O catálogo não respondeu agora. Diga que vai confirmar com o time interno; não invente preço, link ou disponibilidade.";

const CURA_PATTERN =
  /\b(?:cura|curas|curar|cure|curativ\w*|terapia\w*|terapeutic\w*|tratamento\w*|tratar|ansiedade|depressao|doenca\w*|insonia|dores?|sintomas?|medic\w*|saude|clinic\w*)\b/;

const STOPWORDS = new Set([
  "a", "ao", "aos", "as", "da", "das", "de", "do", "dos", "e", "em", "o", "os", "um", "uma",
  "uns", "umas", "no", "na", "nos", "nas", "pra", "pro", "pras", "pros", "para", "por", "com",
  "qual", "quais", "quanto", "custa", "preco", "valor", "quero", "queria", "comprar", "compro",
  "produto", "produtos", "loja", "link", "tem", "teria", "tenho", "vende", "vendem", "voces",
  "voce", "algo", "alguma", "algum", "algumas", "alguns", "coisa", "coisas", "opcao", "opcoes",
  "modelo", "modelos", "ainda", "esta", "estao", "disponivel", "estoque", "soundfulness",
  "oficial", "me", "mim", "minha", "meu", "sobre", "favor", "gostaria", "saber", "existe",
  "ter", "isso", "esse", "essa", "aquele", "aquela", "ai", "la", "aqui", "bom", "boa",
]);

const SINONIMOS: Record<string, string> = {
  minutos: "min", minuto: "min", mins: "min",
  centimetros: "cm", centimetro: "cm",
  handpan: "hand", hang: "hand",
  gongo: "gong", gongos: "gong", gongs: "gong",
  tacas: "taca", tigelas: "taca", tigela: "taca", bowl: "taca", bowls: "taca",
  tibetanas: "tibetana", tibetanos: "tibetana", tibetano: "tibetana",
  baquetas: "baqueta", kits: "kit", combos: "combo",
  sonoro: "som", sonora: "som", sonoros: "som", sonoras: "som", sons: "som",
  massagens: "massagem", meditacoes: "meditacao", meditar: "meditacao",
};

function normalizar(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Tokens comparáveis: separa número de unidade ("10min" → "10", "min") e aplica sinônimos. */
export function tokens(value: string): string[] {
  const raw = normalizar(value)
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .match(/[a-z0-9]+/g) ?? [];
  return raw
    .map(token => SINONIMOS[token] ?? token)
    .map(token => (token.length > 4 && token.endsWith("s") && !/\d/.test(token) ? token.slice(0, -1) : token))
    .filter(token => !STOPWORDS.has(token));
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 4 || right.length < 4 || Math.abs(left.length - right.length) > 1) return false;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  if (left.length === right.length) return left.slice(prefix + 1) === right.slice(prefix + 1);
  const [longer, shorter] = left.length > right.length ? [left, right] : [right, left];
  return longer.slice(prefix + 1) === shorter.slice(prefix);
}

function contemToken(lista: string[], token: string): "exato" | "aprox" | null {
  if (lista.includes(token)) return "exato";
  if (/\d/.test(token)) return null;
  return lista.some(candidate => editDistanceAtMostOne(candidate, token)) ? "aprox" : null;
}

interface PartesNome {
  /** Tokens antes de " para " — o que o produto é. */
  cabeca: string[];
  /** Tokens depois de " para " — a que o acessório se destina. */
  destino: string[];
}

function partesNome(nome: string): PartesNome {
  const [cabeca, ...resto] = normalizar(nome).split(/\s+para\s+/);
  return { cabeca: tokens(cabeca ?? ""), destino: tokens(resto.join(" ")) };
}

function linhasDescricao(product: CatalogProduct): string[] {
  if (product.descriptionSource !== "wix" || !product.description) return [];
  const linhas = product.description.split(/\n+/).map(linha => linha.trim()).filter(Boolean);
  if (linhas.length > 0 && normalizar(linhas[0]!).startsWith(normalizar(product.name).slice(0, 20))) {
    linhas.shift();
  }
  return linhas;
}

function pareceRotulo(linha: string): boolean {
  return linha.length <= 60 && !/[.!?:;]$/.test(linha);
}

/** Rótulo curto da 2ª linha da descrição Wix (ex.: "Acessórios", "Água"). */
export function rotuloCategoria(product: CatalogProduct): string | null {
  const [primeira] = linhasDescricao(product);
  return primeira && primeira.length <= 30 && pareceRotulo(primeira) ? primeira : null;
}

/**
 * Primeiro parágrafo da descrição Wix, até ~200 caracteres, sem frases com
 * linguagem de cura ou tratamento. `null` quando a descrição não é da Wix.
 */
export function descricaoCurta(product: CatalogProduct, maximo = 200): string | null {
  const paragrafo = linhasDescricao(product).find(linha => !pareceRotulo(linha));
  if (!paragrafo) return null;
  const frases = paragrafo.match(/[^.!?]+[.!?]*/g) ?? [paragrafo];
  const seguras = frases.map(frase => frase.trim()).filter(frase => frase && !CURA_PATTERN.test(normalizar(frase)));
  let texto = "";
  for (const frase of seguras) {
    const proximo = texto ? `${texto} ${frase}` : frase;
    if (proximo.length > maximo) break;
    texto = proximo;
  }
  if (!texto && seguras[0]) {
    const corte = seguras[0].slice(0, maximo);
    texto = `${corte.slice(0, Math.max(corte.lastIndexOf(" "), 1)).trim()}…`;
  }
  return texto || null;
}

export function produtoParaSofia(product: CatalogProduct, motivo: string): ProdutoSofia {
  const facts = getPublicProductFacts(product);
  return {
    id: facts.id,
    sku: facts.sku,
    nome: facts.name,
    descricao_curta: descricaoCurta(product),
    preco: facts.price,
    preco_max: facts.priceMax !== null && facts.price !== null && facts.priceMax > facts.price ? facts.priceMax : null,
    moeda: facts.currency || "BRL",
    disponibilidade: facts.availability,
    url: facts.url?.trim() ? facts.url.trim() : null,
    motivo_match: motivo,
  };
}

function limiteValido(limite: number | null | undefined): number {
  if (typeof limite !== "number" || !Number.isFinite(limite)) return LIMITE_PADRAO;
  return Math.min(Math.max(Math.trunc(limite), 1), LIMITE_MAXIMO);
}

const ORDEM_DISPONIBILIDADE: Record<Disponibilidade, number> = { disponivel: 0, indeterminada: 1, indisponivel: 2 };

function ordenar(itens: Array<{ product: CatalogProduct; score: number }>, menorPreco: boolean) {
  return itens.sort((a, b) => {
    const dispA = ORDEM_DISPONIBILIDADE[getPublicProductFacts(a.product).availability];
    const dispB = ORDEM_DISPONIBILIDADE[getPublicProductFacts(b.product).availability];
    if (dispA !== dispB) return dispA - dispB;
    if (menorPreco) {
      const precoA = a.product.price ?? Number.POSITIVE_INFINITY;
      const precoB = b.product.price ?? Number.POSITIVE_INFINITY;
      if (precoA !== precoB) return precoA - precoB;
    }
    return b.score - a.score || a.product.name.localeCompare(b.product.name, "pt-BR");
  });
}

/** Filtros declarados pela pessoa: só produtos visíveis e dentro do teto de preço. */
function aplicaFiltros(products: CatalogProduct[], input: BuscarProdutoInput): CatalogProduct[] {
  const precoMax = typeof input.preco_max === "number" && input.preco_max > 0 ? input.preco_max : null;
  return products.filter(product => {
    if (product.visible === false) return false;
    if (precoMax !== null && (product.price === null || product.price > precoMax)) return false;
    return true;
  });
}

/**
 * Categoria é palpite do modelo ("instrumentos", "acessórios") e não precisa
 * bater com os rótulos da Wix: estreita o ranking quando casa com algo e é
 * ignorada quando não casa com nada, para nunca esconder o catálogo.
 */
function filtraCategoria(products: CatalogProduct[], categoria: string | null | undefined): CatalogProduct[] {
  const termos = categoria?.trim() ? tokens(categoria) : [];
  if (termos.length === 0) return products;
  const filtrados = products.filter(product => {
    const alvo = [...tokens(product.name), ...tokens(rotuloCategoria(product) ?? "")];
    return termos.every(token => contemToken(alvo, token));
  });
  return filtrados.length > 0 ? filtrados : products;
}

interface Pontuacao {
  product: CatalogProduct;
  score: number;
  /** Todos os termos da consulta aparecem no que o produto é (antes de "para"). */
  coberturaCabeca: boolean;
  /** Todos os termos aparecem no nome, inclusive como destino do acessório. */
  coberturaNome: boolean;
  termosNoNome: number;
}

function pontuar(product: CatalogProduct, consultaPartes: PartesNome, uso: string[]): Pontuacao {
  const { cabeca, destino } = partesNome(product.name);
  const nome = [...cabeca, ...destino];
  const consulta = [...consultaPartes.cabeca, ...consultaPartes.destino];
  const descricao = tokens(linhasDescricao(product).join(" "));
  const rotulo = tokens(rotuloCategoria(product) ?? "");
  let score = 0;
  let naCabeca = 0;
  let noNome = 0;
  for (const token of consulta) {
    // "baqueta para gong": o destino da consulta pode estar em qualquer parte do nome.
    const noDestinoDaConsulta = consultaPartes.destino.includes(token);
    const head = contemToken(cabeca, token) ?? (noDestinoDaConsulta ? contemToken(destino, token) : null);
    const tail = head ? null : contemToken(destino, token);
    if (head) {
      naCabeca++;
      noNome++;
      score += head === "exato" ? 10 : 6;
    } else if (tail) {
      noNome++;
      score += tail === "exato" ? 4 : 2;
    } else if (contemToken(rotulo, token)) {
      score += 2;
    } else if (descricao.includes(token)) {
      score += 1;
    }
  }
  for (const token of uso) {
    if (contemToken(nome, token)) score += 3;
    else if (descricao.includes(token)) score += 2;
  }
  // Nomes muito mais longos que a consulta são escolhas menos diretas.
  score -= Math.max(cabeca.length - consulta.length, 0) * 0.25;
  return {
    product,
    score,
    coberturaCabeca: consulta.length > 0 && naCabeca === consulta.length,
    coberturaNome: consulta.length > 0 && noNome === consulta.length,
    termosNoNome: noNome,
  };
}

/** Núcleo puro de `buscar_produto`, testável com catálogo de fixture. */
export function buscarProdutoNoCatalogo(products: CatalogProduct[], input: BuscarProdutoInput): ResultadoProdutos {
  const limite = limiteValido(input.limite);
  const menorPreco = typeof input.preco_max === "number" && input.preco_max > 0;
  const visiveis = aplicaFiltros(products, input);
  const candidatos = filtraCategoria(visiveis, input.categoria);
  const consultaPartes = partesNome(input.consulta ?? "");
  const consulta = [...consultaPartes.cabeca, ...consultaPartes.destino];
  const uso = tokens(input.uso ?? "");

  // Passo 1: identidade por nome/SKU (mesma regra estrita do restante do sistema).
  // O nome que a pessoa disse vence a categoria que o modelo supôs.
  const identidade = input.consulta?.trim() ? matchPublishedProducts(visiveis, input.consulta, LIMITE_MAXIMO) : [];
  if (identidade.length === 1 && uso.length === 0) {
    return { tipo_match: "exato", produtos: [produtoParaSofia(identidade[0]!, "nome_ou_sku")] };
  }

  // Passo 2: ranking determinístico e explicável.
  const pontuados = candidatos
    .map(product => pontuar(product, consultaPartes, uso))
    .filter(item => item.score > 0);
  if (pontuados.length === 0) {
    return consulta.length === 0 && uso.length === 0
      ? { tipo_match: "nenhum", produtos: [], instrucao: "Peça à pessoa o nome ou o tipo de produto que procura." }
      : { tipo_match: "nenhum", produtos: [], instrucao: INSTRUCAO_NENHUM };
  }

  const cabeca = pontuados.filter(item => item.coberturaCabeca);
  const nome = pontuados.filter(item => item.coberturaNome);
  const fortes = cabeca.length > 0 ? cabeca : nome;
  if (fortes.length > 0) {
    if (fortes.length === 1) {
      return { tipo_match: "exato", produtos: [produtoParaSofia(fortes[0]!.product, "nome")] };
    }
    // Vários itens com todos os termos: uma família. Se só um bate números/unidades, ele é o exato.
    const numericos = consulta.filter(token => /\d/.test(token));
    if (numericos.length > 0) {
      const comNumeros = fortes.filter(item => numericos.every(token => tokens(item.product.name).includes(token)));
      if (comNumeros.length === 1) {
        return { tipo_match: "exato", produtos: [produtoParaSofia(comNumeros[0]!.product, "nome")] };
      }
    }
    const ordenados = ordenar(fortes, menorPreco).slice(0, limite);
    return {
      tipo_match: "familia",
      produtos: ordenados.map(item => produtoParaSofia(item.product, uso.length > 0 ? "familia_e_uso" : "familia")),
    };
  }

  if (consulta.length === 0) {
    // Busca só por uso/categoria ("algo para massagem sonora").
    const ordenados = ordenar(pontuados, menorPreco).slice(0, limite);
    return { tipo_match: "familia", produtos: ordenados.map(item => produtoParaSofia(item.product, "uso")) };
  }

  const parecidos = pontuados.filter(item => item.termosNoNome > 0 || item.score >= 3);
  if (parecidos.length === 0) return { tipo_match: "nenhum", produtos: [], instrucao: INSTRUCAO_NENHUM };
  const ordenados = ordenar(parecidos.sort((a, b) => b.score - a.score).slice(0, LIMITE_MAXIMO * 2), menorPreco)
    .slice(0, limite);
  return {
    tipo_match: "similar",
    produtos: ordenados.map(item => produtoParaSofia(item.product, "parecido")),
    instrucao: INSTRUCAO_SIMILAR,
  };
}

function localizarAlvo(products: CatalogProduct[], input: ProdutosSimilaresInput): CatalogProduct | null {
  const id = input.produto_id?.trim();
  if (id) {
    const porId = products.find(product => product.id === id);
    if (porId) return porId;
  }
  const sku = input.sku?.trim();
  if (sku) {
    const alvo = normalizar(sku);
    const porSku = products.find(product => product.skus.some(item => normalizar(item) === alvo));
    if (porSku) return porSku;
  }
  const nome = input.nome?.trim();
  if (nome) {
    const encontrados = matchPublishedProducts(products, nome, 2);
    if (encontrados.length === 1) return encontrados[0]!;
  }
  return null;
}

/** Núcleo puro de `produtos_similares`. */
export function produtosSimilaresNoCatalogo(products: CatalogProduct[], input: ProdutosSimilaresInput): ResultadoProdutos {
  const limite = limiteValido(input.limite);
  const visiveis = products.filter(product => product.visible !== false);
  const alvo = localizarAlvo(visiveis, input);
  if (!alvo) {
    const consulta = input.nome ?? input.sku ?? "";
    if (!consulta.trim()) {
      return { tipo_match: "nenhum", produtos: [], instrucao: "Informe o produto de referência (id, SKU ou nome)." };
    }
    return buscarProdutoNoCatalogo(visiveis, { consulta, limite });
  }

  const partesAlvo = partesNome(alvo.name);
  const rotuloAlvo = rotuloCategoria(alvo);
  const alvoIndisponivel = getPublicProductFacts(alvo).availability === "indisponivel";
  const pontuados = visiveis
    .filter(product => product.id !== alvo.id && normalizar(product.name) !== normalizar(alvo.name))
    .map(product => {
      const partes = partesNome(product.name);
      const cabecaComum = partesAlvo.cabeca.filter(token => !/\d/.test(token) && contemToken(partes.cabeca, token)).length;
      const destinoComum = partesAlvo.destino.filter(token => contemToken(partes.destino, token)).length;
      const mesmaCategoria = rotuloAlvo !== null && rotuloCategoria(product) === rotuloAlvo;
      const score = cabecaComum * 4 + destinoComum * 2 + (mesmaCategoria ? 2 : 0);
      const motivo = alvoIndisponivel && cabecaComum > 0
        ? "alternativa_ao_item_indisponivel"
        : cabecaComum > 0 ? "mesma_familia" : mesmaCategoria ? "mesma_categoria" : "mesmo_uso";
      return { product, score, motivo };
    })
    .filter(item => item.score >= 4);

  if (pontuados.length === 0) return { tipo_match: "nenhum", produtos: [], instrucao: INSTRUCAO_NENHUM };
  const ordenados = pontuados
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMITE_MAXIMO * 2)
    .sort((a, b) => {
      const dispA = ORDEM_DISPONIBILIDADE[getPublicProductFacts(a.product).availability];
      const dispB = ORDEM_DISPONIBILIDADE[getPublicProductFacts(b.product).availability];
      return dispA - dispB || b.score - a.score || a.product.name.localeCompare(b.product.name, "pt-BR");
    })
    .slice(0, limite);
  return {
    tipo_match: "similar",
    produtos: ordenados.map(item => produtoParaSofia(item.product, item.motivo)),
    instrucao: "Apresente como opções parecidas, nunca como o mesmo produto.",
  };
}

export async function buscarProduto(input: BuscarProdutoInput): Promise<ResultadoProdutos> {
  try {
    const { products } = await getPublishedCatalog();
    return buscarProdutoNoCatalogo(products, input);
  } catch {
    return { tipo_match: "erro", produtos: [], instrucao: INSTRUCAO_ERRO };
  }
}

export async function produtosSimilares(input: ProdutosSimilaresInput): Promise<ResultadoProdutos> {
  try {
    const { products } = await getPublishedCatalog();
    return produtosSimilaresNoCatalogo(products, input);
  } catch {
    return { tipo_match: "erro", produtos: [], instrucao: INSTRUCAO_ERRO };
  }
}

/** URLs que este resultado autoriza no texto final do turno. */
export function urlsDeProdutos(resultado: ResultadoProdutos): string[] {
  return resultado.produtos.map(produto => produto.url).filter((url): url is string => Boolean(url));
}
