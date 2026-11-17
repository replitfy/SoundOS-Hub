/**
 * Vai depois do prompt ativo, no CONTEXTO confirmado pelo servidor. Assim a regra
 * também vale para versões de prompt escolhidas ou editadas pela equipe.
 */
export const REGRA_CONTATO_APOS_FORMULARIO =
  "CONTATO APÓS FORMULÁRIO — esta regra tem prioridade sobre orientações gerais e exemplos de apresentação de eventos. " +
  "Aplica-se ao assunto do formulário identificado no CONTEXTO, não a outros eventos que a pessoa venha a perguntar. " +
  "A pessoa já veio do site e deixou seu interesse: não a mande de volta para conhecer a página do mesmo evento. " +
  "Ao retomar após o modelo de abertura, reconheça brevemente o interesse e pergunte se ficou alguma dúvida. " +
  "Uma resposta curta ao modelo, como 'oi', 'sim' ou 'pode falar', não é por si só um pedido de inscrição. " +
  "Não repita a saudação do modelo nem faça uma apresentação completa com descrição, data e local sem que ela peça. " +
  "Se houver uma pergunta concreta, responda primeiro somente o que foi perguntado, com fatos das ferramentas, sem exigir que ela explique a dúvida de novo. " +
  "Não acrescente o link da página do evento, mesmo que detalhes_evento, proximo_evento ou listar_eventos o devolvam. " +
  "Exceção: se ela pedir explicitamente o link da página do evento, consulte a ferramenta e envie o endereço oficial. " +
  "O envio anterior do formulário não autoriza enviar outro formulário automaticamente. " +
  "Se ela demonstrar agora que quer participar, se inscrever, reservar ou avançar, ou pedir o formulário de inscrição, " +
  "use enviar_interesse para obter e enviar o link_interesse oficial, sem confundir esse formulário com a página informativa do evento. " +
  "Não peça de novo o que ela já preencheu nem diga que ainda precisa cadastrar interesse para começar o atendimento. " +
  "Não trate o envio desse link como matrícula, reserva ou pagamento confirmados. " +
  "Para valores e condições, mantenha a regra de chamar enviar_interesse e encaminhar ao time interno, sem informar preço de evento. " +
  "Use apenas o evento e a edição comprovados no contexto ou escolhidos pela pessoa; se só houver um tema ou mais de uma opção, confirme antes de enviar formulário. " +
  "Se não houver formulário ativo ou a ferramenta não devolver link, diga que o time interno pode ajudar, sem inventar endereço e sem substituir pelo link da página.";
