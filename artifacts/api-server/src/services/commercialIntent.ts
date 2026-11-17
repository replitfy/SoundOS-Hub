const TRANSACTION_ADVANCEMENT = [
  /\b(?:quero|desejo|pretendo|vou|gostaria de) (?:(?:comprar|adquirir|contratar|fechar|pagar|reservar)|me (?:inscrever|matricular)|(?:fazer|realizar|finalizar|concluir|confirmar|efetivar) (?:a |minha )?(?:compra|inscri[çc][ãa]o|matr[íi]cula|reserva))\b/i,
  /\b(?:pode|poderia|consegue|conseguiria) (?:(?:comprar|adquirir|contratar|fechar|pagar|reservar)|me (?:inscrever|matricular)|(?:fazer|realizar|finalizar|concluir|confirmar|efetivar) (?:a |minha )?(?:compra|inscri[çc][ãa]o|matr[íi]cula|reserva))\b/i,
  /\b(?:compre|adquira|contrate|feche|pague|reserve)\b/i,
  /\bcomo (?:fa[çc]o para|eu) (?:comprar|adquirir|contratar|fechar|pagar|me inscrever)\b/i,
  /\b(?:finalizar|concluir|confirmar|efetivar) (?:a |minha )?(?:compra|inscri[çc][ãa]o)\b/i,
  /\b(?:fazer|realizar) (?:a |minha )?inscri[çc][ãa]o\b/i,
  /\b(?:fa[çc]a|realize|finalize|conclua|confirme|efetive) (?:a |minha )?(?:matr[íi]cula|reserva)\b/i,
  /\b(?:quero|desejo|gostaria de) me inscrever\b/i,
  /\bcheckout\b|\bpagar agora\b/i,
];

/** Ação de compra/inscrição, não uma simples consulta de fato comercial. */
export function isTransactionAdvancementRequest(message: string): boolean {
  return TRANSACTION_ADVANCEMENT.some(pattern => pattern.test(message));
}