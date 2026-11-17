import type { SofiaToolCall } from "../sofiaModels.js";
import { buscarProduto, produtosSimilares } from "./produtos.js";
import { detalhesEvento, listarEventos, proximoEvento, videoDoEvento } from "./eventos.js";
import { atualizarFicha } from "./ficha.js";
import { enviarInteresse } from "./interesse.js";
import { registrarNaoQuerReceber } from "./naoQuerReceber.js";
import { ocultarValoresEmReais } from "../ocultarValores.js";
import { atualizarCartaoDaConversa } from "../cartaoDaConversa.js";

/** Tools expostas ao modelo no modo simples. Nada de escalateToHuman/updatePessoa/createPessoa/recommendVideos. */

type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

export const SIMPLE_MODE_TOOLS: ToolDef[] = [
  tool(
    "buscar_produto",
    "Busca produtos da loja (instrumentos, kits, acessórios) com preço, disponibilidade e link oficiais. " +
      "Use para qualquer pergunta sobre produto, preço de produto ou link de compra.",
    {
      consulta: { type: "string", description: "O que a pessoa procura, com as palavras dela" },
      uso: { type: ["string", "null"], description: "Para que a pessoa quer usar, se ela disse" },
      categoria: { type: ["string", "null"], description: "Só se a pessoa pediu um tipo de produto; deixe null na dúvida" },
      preco_max: { type: ["number", "null"], description: "Teto de preço em reais, se a pessoa disse" },
      limite: { type: ["integer", "null"], description: "Quantos itens (padrão 3, máximo 5)" },
    },
    ["consulta"],
  ),
  tool(
    "produtos_similares",
    "Produtos parecidos com um item (por id, sku ou nome). Apresente sempre como parecidos, nunca como o mesmo item.",
    {
      produto_id: { type: ["string", "null"] },
      sku: { type: ["string", "null"] },
      nome: { type: ["string", "null"] },
      limite: { type: ["integer", "null"] },
    },
  ),
  tool("proximo_evento", "Próximo evento publicado na agenda oficial, com data, local e link. Não traz preço: valores são sempre do time interno.", {}),
  tool(
    "detalhes_evento",
    "Detalhes de um evento ou ciclo pelo nome que a pessoa usou (aceita apelidos como 'workshop Água'): " +
      "descrição, próxima edição, outras datas e link da página do evento (não é o formulário de inscrição). " +
      "Com formulario_recente no CONTEXTO, responda só a dúvida e não acrescente a página do mesmo evento, salvo pedido explícito desse link. " +
      "Não traz preço: valores são sempre do time interno.",
    { nome: { type: "string", description: "Nome ou apelido do evento como a pessoa escreveu" } },
    ["nome"],
  ),
  tool(
    "listar_eventos",
    "Lista eventos futuros publicados, com datas e links. Filtre por cidade e/ou ciclo quando a pessoa pedir.",
    {
      cidade: { type: ["string", "null"], description: "Cidade (aceita SP, RJ, BH)" },
      ciclo: { type: ["string", "null"], description: "Nome ou apelido do ciclo/evento" },
    },
  ),
  tool(
    "enviar_interesse",
    "Obtém o link do cadastro de interesse de um evento, ciclo ou curso. Use SEMPRE que a pessoa perguntar preço, valor, " +
      "parcelamento, desconto ou condições de pagamento de evento/ciclo/curso, quando disser que quer se inscrever, reservar ou comprar, " +
      "e quando demonstrar vontade de participar ou fazer um evento, ciclo ou curso específico (\"tenho interesse no Ciclo Água\", " +
      "\"quero saber como participar\", \"como faço para entrar\"). Curiosidade informativa (o que é, onde fica, qual a data) não é " +
      "interesse: não use a ferramenta nesses casos. Se a pessoa não disse qual evento, pergunte qual antes de chamar. " +
      "Nunca informe valor de evento: envie o link que esta ferramenta trouxe e diga que o time interno retorna com valores e condições. " +
      "Com formulario_recente no CONTEXTO, não chame só porque houve preenchimento nem por uma confirmação genérica ao modelo de abertura: " +
      "primeiro acolha e verifique dúvidas; chame quando a pessoa quiser avançar ou pedir valores/formulário. " +
      "link_interesse é o formulário oficial, não a página informativa do evento. Não invente link se ele estiver ausente. " +
      "O evento identificado no contexto pode ser usado sem perguntar novamente; tema genérico ou edição ambígua exige confirmação. " +
      "Abre o atendimento no time automaticamente quando a conversa tem ficha. Não serve para produtos da loja.",
    {
      evento: { type: ["string", "null"], description: "Nome ou apelido do evento como a pessoa escreveu ou como vinha sendo conversado. Sem evento a ferramenta não escolhe nenhum: devolve candidatos para você perguntar qual" },
      data: { type: ["string", "null"], description: "AAAA-MM-DD ou AAAA-MM, só se a pessoa indicou uma data ou mês específico" },
    },
  ),
  tool(
    "video_do_evento",
    "Vídeos aprovados de um evento (no máximo 2). Use o campo 'texto' de cada vídeo exatamente como veio.",
    { evento: { type: "string", description: "Nome ou apelido do evento" } },
    ["evento"],
  ),
  tool(
    "atualizar_ficha",
    "Anota na ficha dados que a pessoa disse espontaneamente sobre si (idade, cidade, profissão, interesses...). " +
      "Chame em silêncio, sem avisar a pessoa, e só com o que ela disse literalmente. " +
      "Nunca pergunte nada para preencher a ficha. Nunca envie CPF, saúde ou dados de terceiros.",
    {
      campos: {
        type: "object",
        additionalProperties: false,
        properties: {
          nome: { type: "string" },
          sobrenome: { type: "string" },
          data_nascimento: { type: "string", description: "AAAA-MM-DD, só se a pessoa disse a data completa" },
          idade: { type: "integer", description: "Idade que a pessoa disse" },
          cidade: { type: "string" },
          estado: { type: "string", description: "UF com 2 letras" },
          profissao: { type: "string" },
          email: { type: "string" },
          instagram: { type: "string" },
          servico_interesse: { type: "string" },
          objetivos_declarados: { type: "array", items: { type: "string" }, maxItems: 3 },
          como_ficou_sabendo: { type: "string" },
          preferred_language: { type: "string", enum: ["pt-BR", "fr", "en", "es"] },
        },
      },
    },
    ["campos"],
  ),
  tool(
    "registrar_nao_quer_receber",
    "Registra que a pessoa NÃO quer mais receber mensagens da Soundfulness. Use quando ela pedir claramente para parar, " +
      "sair da lista, não ser mais contatada ou não receber mais mensagens (\"pare\", \"não quero receber\", \"me tira da lista\", " +
      "\"deixa de me mandar mensagem\"), em qualquer formulação. Não use para dúvida, para recusar uma oferta específica " +
      "nem para dizer que agora não pode conversar. Depois de chamar, siga a instrução devolvida: uma despedida curta e mais nada.",
    {},
  ),
];

export const KNOWLEDGE_TOOL: ToolDef = tool(
  "searchKnowledgeBase",
  "Busca na base de conhecimento da Soundfulness (conceitos, como funcionam os cursos, para que servem os instrumentos).",
  { query: { type: "string", description: "Texto da busca em português" } },
  ["query"],
);

/** Só no WhatsApp: a conversa tem um cartão no CRM e a Sofia anota nele o que entende. */
export const CARTAO_TOOL: ToolDef = tool(
  "atualizar_cartao",
  "Registra no cartão do CRM, que a equipe vê, o que você entendeu da conversa: o que a pessoa quer (intencao), o que ela precisa " +
    "(necessidades) e informações úteis que ela deu (informacoes). Chame em silêncio, sem avisar a pessoa, quando a conversa trouxer " +
    "algo novo e claro; não chame a cada mensagem nem repita o que já está no cartão. Escreva frases curtas, no sentido do que a PESSOA " +
    "disse. Nunca registre preço, CPF, e-mail, telefone, link, assunto de saúde, dados de outras pessoas nem o que você mesma disse. " +
    "Se a pessoa mudar de ideia, coloque o item que deixou de valer em 'remover'.",
  {
    intencao: { type: ["string", "null"], description: "O que a pessoa quer agora, em uma frase curta. Substitui a anterior" },
    necessidades: { type: "array", items: { type: "string" }, maxItems: 4, description: "O que ela precisa ou busca, itens novos" },
    informacoes: { type: "array", items: { type: "string" }, maxItems: 4, description: "Fatos úteis que ela contou (disponibilidade, experiência, cidade), itens novos" },
    remover: { type: "array", items: { type: "string" }, maxItems: 4, description: "Itens já anotados que deixaram de valer" },
  },
);

export interface SimpleToolContext {
  pessoaId: number | null;
  conversationId: number;
  /** Canal externo da conversa; `atualizar_cartao` só existe no WhatsApp. */
  canal?: "whatsapp";
  searchKnowledge?: (query: string) => Promise<Array<{ title: string; contentPreview: string }>>;
  now?: Date;
}

export { ocultarValoresEmReais };

function erro(mensagem: string): string {
  return JSON.stringify({ erro: mensagem });
}

/** Executa uma tool call do modo simples. Falhas voltam ao modelo como `{erro}` curto. */
export async function executarToolSimples(call: SofiaToolCall, ctx: SimpleToolContext): Promise<string> {
  let args: Record<string, unknown>;
  try {
    const parsed = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
    args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return erro("Argumentos inválidos. Chame de novo com JSON válido.");
  }
  const texto = (valor: unknown) => (typeof valor === "string" ? valor : "");
  switch (call.function.name) {
    case "buscar_produto":
      if (!texto(args.consulta).trim()) return erro("Informe 'consulta' com o que a pessoa procura.");
      return JSON.stringify(await buscarProduto(args as unknown as Parameters<typeof buscarProduto>[0]));
    case "produtos_similares":
      return JSON.stringify(await produtosSimilares(args as Parameters<typeof produtosSimilares>[0]));
    case "proximo_evento":
      return JSON.stringify(await proximoEvento(ctx.now));
    case "detalhes_evento":
      if (!texto(args.nome).trim()) return erro("Informe 'nome' do evento.");
      return JSON.stringify(await detalhesEvento({ nome: texto(args.nome) }, ctx.now));
    case "listar_eventos":
      return JSON.stringify(await listarEventos({ cidade: texto(args.cidade) || null, ciclo: texto(args.ciclo) || null }, ctx.now));
    case "enviar_interesse":
      // pessoaId vem da conversa; qualquer pessoaId enviado pelo modelo é ignorado.
      return JSON.stringify(await enviarInteresse({
        evento: texto(args.evento) || null,
        data: texto(args.data) || null,
        pessoaId: ctx.pessoaId,
        conversationId: ctx.conversationId,
        now: ctx.now,
      }));
    case "video_do_evento":
      if (!texto(args.evento).trim()) return erro("Informe 'evento'.");
      return JSON.stringify(await videoDoEvento({ evento: texto(args.evento) }, ctx.now));
    case "atualizar_ficha":
      // pessoaId vem da conversa; qualquer pessoaId enviado pelo modelo é ignorado.
      return JSON.stringify(await atualizarFicha({ pessoaId: ctx.pessoaId, conversationId: ctx.conversationId, campos: args.campos, now: ctx.now }));
    case "atualizar_cartao":
      // A ficha vem da conversa; o modelo nunca informa pessoa nem cartão.
      if (ctx.canal !== "whatsapp") return erro("Ferramenta indisponível neste canal.");
      return JSON.stringify(await atualizarCartaoDaConversa({
        conversationId: ctx.conversationId,
        entrada: { intencao: args.intencao, necessidades: args.necessidades, informacoes: args.informacoes, remover: args.remover },
        now: ctx.now,
      }));
    case "registrar_nao_quer_receber":
      // pessoaId vem da conversa; qualquer pessoaId enviado pelo modelo é ignorado.
      return JSON.stringify(await registrarNaoQuerReceber({ pessoaId: ctx.pessoaId, conversationId: ctx.conversationId }));
    case "searchKnowledgeBase": {
      if (!ctx.searchKnowledge) return erro("Base de conhecimento indisponível.");
      const resultados = await ctx.searchKnowledge(texto(args.query));
      // Valor em reais nunca sai da base de conhecimento: preço de produto vem de
      // buscar_produto e preço de evento nunca é informado. Sem isto, um valor
      // citado num documento entraria na lista de valores permitidos do turno.
      return JSON.stringify(resultados.length === 0
        ? { resultado: "Nada encontrado na base de conhecimento." }
        : { trechos: resultados.map(r => ({ titulo: r.title, conteudo: ocultarValoresEmReais(r.contentPreview) })) });
    }
    default:
      return erro(`Ferramenta desconhecida: ${call.function.name}.`);
  }
}
