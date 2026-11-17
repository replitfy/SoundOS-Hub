import type { Request, Response } from "express";

// O motor do modo simples escreve a resposta como SSE num `Response`. Para canais
// sem tela (Instagram) usamos o MESMO motor: este adaptador faz o papel do
// Response, junta o texto e guarda o evento final, sem criar um segundo caminho.

export interface RespostaColetada {
  texto: string;
  concluida: boolean;
  erro: { mensagem: string; codigo?: string } | null;
  handoffAcionado: boolean;
  conversationId: number | null;
}

interface EventoSse {
  content?: string;
  done?: boolean;
  error?: string;
  code?: string;
  handoffTriggered?: boolean;
  conversationId?: number;
}

export function criarRespostaColetora(log: Request["log"]) {
  let pendente = "";
  let texto = "";
  let concluida = false;
  let erro: RespostaColetada["erro"] = null;
  let handoffAcionado = false;
  let conversationId: number | null = null;

  const processar = (bloco: string) => {
    for (const linha of bloco.split("\n")) {
      if (!linha.startsWith("data: ")) continue;
      let evento: EventoSse;
      try { evento = JSON.parse(linha.slice(6)) as EventoSse; } catch { continue; }
      if (typeof evento.content === "string") texto += evento.content;
      if (evento.error) erro = { mensagem: evento.error, codigo: evento.code };
      if (evento.done) {
        concluida = true;
        handoffAcionado = evento.handoffTriggered === true;
        if (typeof evento.conversationId === "number") conversationId = evento.conversationId;
      }
    }
  };

  const res = {
    destroyed: false,
    headersSent: false,
    setHeader() { return res; },
    write(pedaco: string) {
      pendente += pedaco;
      let fim = pendente.indexOf("\n\n");
      while (fim !== -1) {
        processar(pendente.slice(0, fim));
        pendente = pendente.slice(fim + 2);
        fim = pendente.indexOf("\n\n");
      }
      return true;
    },
    end() {
      if (pendente.trim() !== "") processar(pendente);
      pendente = "";
      res.destroyed = true;
    },
  };

  return {
    req: { log } as unknown as Request,
    res: res as unknown as Response,
    resultado(): RespostaColetada {
      return { texto: texto.trim(), concluida, erro, handoffAcionado, conversationId };
    },
  };
}
