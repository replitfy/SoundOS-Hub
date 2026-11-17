import { interpretarEventoHablla } from "./habllaEvento";
import { dividirParaInstagram } from "./instagramTexto";
import {
  processarEventoDoCanal, type AdaptadorDeCanal, type DesfechoEvento, type ProcessarEventoDeps,
} from "./sofiaCanalPipeline";

// Instagram: DM recebida pelo Hablla. O pipeline é o comum (sofiaCanalPipeline); aqui só ficam as
// regras do canal. Sem evidência POSITIVA de que a mensagem veio do cliente, a Sofia não responde.

export { criarRodarSofiaSimples } from "./sofiaCanalPipeline";
export type { DesfechoEvento, ProcessarEventoDeps, RespostaDaSofia } from "./sofiaCanalPipeline";

const adaptadorInstagram: AdaptadorDeCanal = {
  canal: "instagram",
  rotulo: "hablla instagram",
  respondeLigado: config => config.instagramResponde === true,
  dividir: dividirParaInstagram,
  estadoAoEnviar: "enviado",
  interpretar(payload) {
    const dados = interpretarEventoHablla(payload);
    if (dados.direcao === "saida") return { acao: "ignorar", motivo: "mensagem_enviada_pela_conta" };
    if (dados.direcao === "desconhecida") return { acao: "ignorar", motivo: "origem_nao_reconhecida" };
    if (!dados.contatoId) return { acao: "ignorar", motivo: "contato_nao_identificado" };
    if (!dados.texto) return { acao: "ignorar", motivo: dados.temAnexo ? "mensagem_sem_texto" : "sem_texto" };
    return {
      acao: "mensagem",
      mensagem: {
        contatoId: dados.contatoId,
        destinatario: dados.contatoId,
        texto: dados.texto,
        usuario: dados.usuario,
        titulo: dados.usuario ? `Instagram @${dados.usuario}` : "Instagram",
        canalUsuario: dados.usuario,
      },
    };
  },
};

export function processarEventoInstagram(eventoId: number, deps: ProcessarEventoDeps): Promise<DesfechoEvento | null> {
  return processarEventoDoCanal(eventoId, adaptadorInstagram, deps);
}
