import { logger } from "../lib/logger";
import { reconciliarEntrega, registrarResultadoDeEnvio, registrarStatusDeEntrega, type ResultadoEntrega } from "./entregaWhatsapp";
import { HabllaErro, idDaConexaoConfigurada } from "./habllaClient";
import { interpretarEventoWhatsapp, type EsperadoWhatsapp } from "./habllaEventoWhatsapp";
import {
  processarEventoDoCanal, type AdaptadorDeCanal, type DesfechoEvento, type ProcessarEventoDeps,
} from "./sofiaCanalPipeline";
import { dividirParaWhatsapp } from "./whatsappTexto";

// WhatsApp: mensagens recebidas e eventos de entrega pelo Hablla. As regras de interpretação ficam em
// habllaEventoWhatsapp (estritas); o pipeline de resposta é o comum aos canais.

export interface ProcessarEventoWhatsappDeps extends ProcessarEventoDeps {
  /** Workspace e conexão configurados. Por padrão vêm do ambiente. */
  esperado?: () => EsperadoWhatsapp;
}

export function esperadoDoAmbiente(env: NodeJS.ProcessEnv = process.env): EsperadoWhatsapp {
  return {
    workspaceId: env.HABLLA_WORKSPACE_ID?.trim() || null,
    conexaoId: idDaConexaoConfigurada("whatsapp", env),
  };
}

/** Números do Brasil chegam como 55 + DDD + número; a conversa e a busca de ficha usam a forma sem o 55. */
const BRASIL_COM_PAIS = /^55\d{10,11}$/;

export function chaveDoContatoWhatsapp(telefone: string): string {
  return BRASIL_COM_PAIS.test(telefone) ? telefone.slice(2) : telefone;
}

/** "+55 11 99999-9999" para números do Brasil; "+dígitos" para os demais. */
export function telefoneParaExibir(telefone: string): string {
  if (!BRASIL_COM_PAIS.test(telefone)) return `+${telefone}`;
  const nacional = telefone.slice(2);
  const ddd = nacional.slice(0, 2);
  const numero = nacional.slice(2);
  return `+55 ${ddd} ${numero.slice(0, numero.length - 4)}-${numero.slice(-4)}`;
}

function motivoDaEntrega(resultado: ResultadoEntrega, prefixo: string, status: string): string {
  if (resultado.resultado === "desconhecido") {
    // Só o fato, sem o id: o id da Meta carrega o telefone codificado.
    logger.warn({ status }, "hablla whatsapp: evento de entrega de um envio desconhecido");
    return "envio_desconhecido";
  }
  return resultado.resultado === "atualizado" ? `${prefixo}:${resultado.estado}` : `${prefixo}_sem_mudanca:${resultado.estado}`;
}

function criarAdaptador(esperado: EsperadoWhatsapp): AdaptadorDeCanal {
  /** Um aviso que acabou de ligar a fila ao id da Meta libera os que chegaram antes dele. */
  const reconciliarSeLigou = async (resultado: ResultadoEntrega): Promise<void> => {
    if (resultado.resultado === "desconhecido" || !resultado.ligouIdDaMeta) return;
    // O estado deste evento já foi gravado: uma falha ao reaplicar os pendentes não pode transformá-lo em erro.
    await reconciliarEntrega(resultado.ligouIdDaMeta, esperado)
      .catch(erro => logger.warn({ erroTipo: (erro as { name?: string })?.name }, "hablla whatsapp: não consegui reaplicar avisos de entrega pendentes"));
  };
  return {
    canal: "whatsapp",
    rotulo: "hablla whatsapp",
    respondeLigado: config => config.whatsappResponde === true,
    dividir: dividirParaWhatsapp,
    estadoAoEnviar: "aceito",
    logSemDetalhesDoErro: true,
    aoRegistrarEnvio: async filaId => { await reconciliarEntrega(filaId, esperado); },
    motivoDaFalhaDeEnvio: erro => (erro instanceof HabllaErro && erro.codigo === "janela_24h" ? "fora_da_janela_24h" : null),
    async interpretar(payload) {
      const evento = interpretarEventoWhatsapp(payload, esperado);
      switch (evento.tipo) {
        case "ignorado":
          return { acao: "ignorar", motivo: evento.motivo };
        case "status": {
          const resultado = await registrarStatusDeEntrega(evento);
          await reconciliarSeLigou(resultado);
          return { acao: "ignorar", motivo: motivoDaEntrega(resultado, "entrega", evento.status) };
        }
        case "resultado_envio": {
          const resultado = await registrarResultadoDeEnvio(evento);
          await reconciliarSeLigou(resultado);
          return { acao: "ignorar", motivo: motivoDaEntrega(resultado, evento.sucesso ? "resultado_de_envio" : "resultado_de_envio_falhou", evento.sucesso ? "success" : "error") };
        }
        case "mensagem":
          return {
            acao: "mensagem",
            mensagem: {
              contatoId: chaveDoContatoWhatsapp(evento.telefone),
              destinatario: evento.telefone,
              texto: evento.texto,
              ...(evento.anexo ? { anexo: evento.anexo } : {}),
              usuario: evento.nomePerfil,
              titulo: `WhatsApp ${telefoneParaExibir(evento.telefone)}`,
              canalUsuario: evento.telefone,
            },
          };
      }
    },
  };
}

export function processarEventoWhatsapp(eventoId: number, deps: ProcessarEventoWhatsappDeps): Promise<DesfechoEvento | null> {
  return processarEventoDoCanal(eventoId, criarAdaptador((deps.esperado ?? esperadoDoAmbiente)()), deps);
}
