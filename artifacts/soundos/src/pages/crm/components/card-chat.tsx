import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Paperclip, Send, X } from "lucide-react";
import {
  getGetCommercialOpportunityChatQueryKey,
  getListConversationsAwaitingStaffQueryKey,
  getListConversationsQueryKey,
  useAssumeCommercialOpportunityChat,
  useGetCommercialOpportunityChat,
  useLinkCommercialOpportunityConversation,
  useMarkCommercialOpportunityChatSeen,
  useReturnCommercialOpportunityChat,
  useSendCommercialOpportunityChatAttachment,
  useSendCommercialOpportunityChatMessage,
  type Message,
} from "@workspace/api-client-react";
import { AnexoDaMensagem, tamanhoLegivel } from "@/components/anexo-da-mensagem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useLang, type TranslationKey } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { errorText } from "../atendimento-errors";
import { useCardAbertura } from "../abertura-hooks";
import { useCardRefresh } from "../use-card-refresh";
import { AberturaModeloDialog } from "./abertura-modelo-dialog";
import { FichasMesmoTelefone } from "./fichas-mesmo-telefone";

const LIMITE_MENSAGEM = 4_000;
/** A conversa é recarregada enquanto o cartão está aberto (e a aba visível). */
const ATUALIZACAO_MS = 5_000;

const LIMITE_LEGENDA = 1_024;
const MB = 1024 * 1024;
/** Limites de envio por tipo (os mesmos do servidor, que confere o tipo real pelo conteúdo). */
const LIMITE_POR_TIPO = { image: 5 * MB, video: 16 * MB, audio: 16 * MB, document: 100 * MB } as const;
type TipoDeArquivo = keyof typeof LIMITE_POR_TIPO;

interface Props {
  opportunityId: number;
  closed: boolean;
  /** A aba da conversa está à vista. Arquivos novos só são dados como vistos com ela aberta. Padrão: sim. */
  ativa?: boolean;
}

interface ItemDaFila {
  chave: number;
  arquivo: File;
  legenda: string;
  tipo: TipoDeArquivo;
  /** Problema visto antes de enviar (tamanho) ou devolvido pelo servidor no último envio. */
  erro: string | null;
  previa: string | null;
}

function tipoDoArquivo(arquivo: File): TipoDeArquivo {
  if (arquivo.type.startsWith("image/")) return "image";
  if (arquivo.type.startsWith("video/")) return "video";
  if (arquivo.type.startsWith("audio/")) return "audio";
  return "document";
}

function autorDaMensagem(m: Message, t: (k: TranslationKey) => string): { rotulo: string; lado: "pessoa" | "equipe" | "sofia" } {
  if (m.role === "user") return { rotulo: t("crm.chat.pessoa"), lado: "pessoa" };
  if (m.kind === "modelo_abertura") {
    // Sem autor humano o modelo saiu pelo primeiro contato automático da Sofia.
    const autor = m.authorUserId == null && !m.authorName ? t("crm.ator.sofia") : (m.authorName ?? t("crm.ator.desconhecido"));
    return { rotulo: `${t("crm.chat.modelo_abertura")} · ${autor}`, lado: "equipe" };
  }
  if (m.role === "staff") return { rotulo: `${t("crm.chat.equipe")} · ${m.authorName ?? t("crm.ator.desconhecido")}`, lado: "equipe" };
  return { rotulo: t("crm.ator.sofia"), lado: "sofia" };
}

/** Mensagem da conversa (também usada na ficha da pessoa, somente leitura). */
export function Bolha({ mensagem, destacar, onRecopiado }: { mensagem: Message; destacar: boolean; onRecopiado: () => void }) {
  const { t } = useLang();
  const { rotulo, lado } = autorDaMensagem(mensagem, t);
  const falhou = mensagem.envioStatus === "falhou";
  return (
    <div className={`flex ${lado === "pessoa" ? "justify-start" : "justify-end"}`} data-testid={`crm-chat-msg-${mensagem.id}`} data-autor={lado}>
      <div className={`max-w-[85%] rounded-lg border p-2.5 text-sm ${
        lado === "pessoa" ? "bg-background" : lado === "equipe" ? "bg-primary/10 border-primary/30" : "bg-muted/60"
      }`}>
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">{rotulo}</p>
        {mensagem.anexo && (
          <div className={mensagem.content ? "mb-1.5" : ""}>
            <AnexoDaMensagem anexo={mensagem.anexo} destacar={destacar} onRecopiado={onRecopiado} />
          </div>
        )}
        {mensagem.content && <p className="whitespace-pre-wrap break-words">{mensagem.content}</p>}
        <p className="mt-1.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
          <span>{formatDateTimeBR(mensagem.createdAt)}</span>
          {mensagem.envioStatus && (
            <span className={falhou ? "font-medium text-destructive" : ""}>{t(`crm.chat.entrega.${mensagem.envioStatus}` as TranslationKey)}</span>
          )}
        </p>
        {falhou && mensagem.envioErro && (
          <p className="mt-1 text-[11px] text-destructive" data-testid={`crm-chat-msg-erro-${mensagem.id}`}>{mensagem.envioErro}</p>
        )}
      </div>
    </div>
  );
}

export function CardChat({ opportunityId, closed, ativa = true }: Props) {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const refresh = useCardRefresh(opportunityId);
  const { data: chat, isLoading, isError } = useGetCommercialOpportunityChat(opportunityId, {
    query: {
      queryKey: getGetCommercialOpportunityChatQueryKey(opportunityId),
      refetchInterval: ATUALIZACAO_MS,
      refetchIntervalInBackground: false,
    },
  });
  const assumirMut = useAssumeCommercialOpportunityChat();
  const devolverMut = useReturnCommercialOpportunityChat();
  const vincularMut = useLinkCommercialOpportunityConversation();
  const enviarMut = useSendCommercialOpportunityChatMessage();
  const enviarArquivoMut = useSendCommercialOpportunityChatAttachment();
  const marcarVistosMut = useMarkCommercialOpportunityChatSeen();

  const [texto, setTexto] = useState("");
  const [aberturaAberta, setAberturaAberta] = useState(false);
  const abertura = useCardAbertura(opportunityId, aberturaAberta);

  // Fila de arquivos a enviar (um por mensagem) e estado do arrastar/soltar.
  const [fila, setFila] = useState<ItemDaFila[]>([]);
  const [enviandoArquivos, setEnviandoArquivos] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const proximaChaveRef = useRef(1);
  const seletorRef = useRef<HTMLInputElement>(null);
  const previasRef = useRef<Set<string>>(new Set());
  useEffect(() => () => { previasRef.current.forEach(url => URL.revokeObjectURL(url)); previasRef.current.clear(); }, []);

  // Arquivos recebidos que ninguém tinha visto: ficam realçados enquanto esta conversa está aberta, mesmo depois
  // de dados como vistos no servidor. O "visto" só é registrado com a conversa à vista (aba ativa).
  const [destacados, setDestacados] = useState<ReadonlySet<number>>(() => new Set());
  const marcadoRef = useRef<string | null>(null);
  const vinculada = chat?.vinculo.tipo === "vinculada";
  const naoVistos = vinculada ? (chat?.mensagens ?? []).flatMap(m => (m.anexo?.naoVisto ? [m.anexo.id] : [])) : [];
  const chaveDosNaoVistos = naoVistos.join(",");
  useEffect(() => {
    if (!ativa || chaveDosNaoVistos === "") return;
    const ids = chaveDosNaoVistos.split(",").map(Number);
    setDestacados(atuais => (ids.every(id => atuais.has(id)) ? atuais : new Set([...atuais, ...ids])));
    if (marcadoRef.current === chaveDosNaoVistos) return;
    marcadoRef.current = chaveDosNaoVistos;
    marcarVistosMut.mutate({ id: opportunityId }, {
      onSuccess: () => {
        refresh();
        void queryClient.invalidateQueries({ queryKey: getListConversationsAwaitingStaffQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
      },
      onError: () => { marcadoRef.current = null; },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativa, chaveDosNaoVistos, opportunityId]);

  const listaRef = useRef<HTMLDivElement>(null);
  const grudadoNoFimRef = useRef(true);
  const ultima = chat?.mensagens.at(-1);
  useEffect(() => {
    const lista = listaRef.current;
    if (lista && grudadoNoFimRef.current) lista.scrollTop = lista.scrollHeight;
  }, [chat?.mensagens.length, ultima?.envioStatus]);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("crm.chat.carregando")}</p>;
  if (isError || !chat) return <p className="text-sm text-destructive">{t("crm.chat.erro")}</p>;

  const onError = (err: unknown) => toast.error(errorText(err, t));
  const equipeAtende = chat.conversa?.status === "atendimento_humano";

  const enviar = () => {
    const mensagem = texto.trim();
    if (!mensagem || enviarMut.isPending) return;
    enviarMut.mutate({ id: opportunityId, data: { texto: mensagem } }, {
      onSuccess: () => { setTexto(""); toast.success(t("crm.chat.enviada")); grudadoNoFimRef.current = true; refresh(); },
      onError: err => { onError(err); refresh(); },
    });
  };

  const podeAnexar = chat.podeEnviarTexto && !closed && !enviandoArquivos;

  const erroDeTamanho = (arquivo: File, tipo: TipoDeArquivo): string | null => {
    if (arquivo.size <= 0) return t("anexo.erro_vazio");
    if (arquivo.size > LIMITE_POR_TIPO[tipo]) return t(`anexo.erro_tamanho_${tipo}` as TranslationKey);
    return null;
  };

  const adicionarArquivos = (arquivos: File[]) => {
    if (!podeAnexar || arquivos.length === 0) return;
    const novos = arquivos.map((arquivo): ItemDaFila => {
      const tipo = tipoDoArquivo(arquivo);
      let previa: string | null = null;
      if (tipo === "image") { previa = URL.createObjectURL(arquivo); previasRef.current.add(previa); }
      return { chave: proximaChaveRef.current++, arquivo, legenda: "", tipo, erro: erroDeTamanho(arquivo, tipo), previa };
    });
    setFila(atual => [...atual, ...novos]);
  };

  const removerDaFila = (chave: number) => {
    setFila(atual => {
      const item = atual.find(i => i.chave === chave);
      if (item?.previa) { URL.revokeObjectURL(item.previa); previasRef.current.delete(item.previa); }
      return atual.filter(i => i.chave !== chave);
    });
  };

  const alterarLegenda = (chave: number, legenda: string) =>
    setFila(atual => atual.map(i => (i.chave === chave ? { ...i, legenda } : i)));

  /** Uma tentativa por arquivo: se falhar, nada é reenviado sozinho e o item continua na fila com o motivo. */
  const enviarItem = async (item: ItemDaFila): Promise<boolean> => {
    const legenda = item.tipo === "audio" ? "" : item.legenda.trim();
    if (item.erro && erroDeTamanho(item.arquivo, item.tipo)) return false;
    if (legenda.length > LIMITE_LEGENDA) {
      setFila(atual => atual.map(i => (i.chave === item.chave ? { ...i, erro: t("anexo.erro_legenda_longa") } : i)));
      return false;
    }
    try {
      await enviarArquivoMut.mutateAsync({ id: opportunityId, data: { arquivo: item.arquivo, ...(legenda ? { legenda } : {}) } });
      removerDaFila(item.chave);
      grudadoNoFimRef.current = true;
      return true;
    } catch (err) {
      setFila(atual => atual.map(i => (i.chave === item.chave ? { ...i, erro: errorText(err, t) } : i)));
      return false;
    } finally {
      refresh();
    }
  };

  const enviarArquivos = async (itens: ItemDaFila[]) => {
    if (!podeAnexar || itens.length === 0) return;
    setEnviandoArquivos(true);
    let enviados = 0;
    try {
      for (const item of itens) {
        // Um de cada vez; ao primeiro que falhar os demais ficam na fila, sem tentativa.
        if (!(await enviarItem(item))) break;
        enviados += 1;
      }
    } finally {
      setEnviandoArquivos(false);
    }
    if (enviados === itens.length) {
      toast.success(itens.length === 1 ? t("anexo.enviado") : t("anexo.enviado_ok_n").replace("{n}", String(enviados)));
    } else {
      toast.error(t("anexo.falhou_n").replace("{n}", String(itens.length - enviados)));
    }
  };

  const aoColar = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const arquivos = Array.from(e.clipboardData?.files ?? []);
    if (arquivos.length === 0 || !podeAnexar) return;
    e.preventDefault();
    adicionarArquivos(arquivos);
  };
  const temArquivos = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const aoSoltar = (e: DragEvent<HTMLElement>) => {
    if (!temArquivos(e)) return;
    e.preventDefault();
    setArrastando(false);
    adicionarArquivos(Array.from(e.dataTransfer.files));
  };

  const janela = chat.janelaAte
    ? chat.janelaAberta
      ? `${t("crm.chat.janela_aberta")} ${formatDateTimeBR(chat.janelaAte)}`
      : `${t("crm.chat.janela_fechada")} ${formatDateTimeBR(chat.janelaAte)}`
    : t("crm.chat.janela_sem_mensagem");

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="crm-chat">
      <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {chat.conversa ? (
            <span className="font-medium" data-testid="crm-chat-status">{t(`crm.chat.status.${chat.conversa.status}` as TranslationKey)}</span>
          ) : <span className="text-muted-foreground">{t("crm.chat.sem_conversa_titulo")}</span>}
          <div className="flex flex-wrap gap-2">
            {vinculada && !closed && (equipeAtende ? (
              <Button size="sm" variant="outline" disabled={devolverMut.isPending} data-testid="crm-chat-devolver"
                onClick={() => devolverMut.mutate({ id: opportunityId }, { onSuccess: refresh, onError })}>{t("crm.chat.devolver")}</Button>
            ) : (
              <Button size="sm" disabled={assumirMut.isPending} data-testid="crm-chat-assumir"
                onClick={() => assumirMut.mutate({ id: opportunityId }, { onSuccess: refresh, onError })}>{t("crm.chat.assumir")}</Button>
            ))}
            {!closed && (
              <Button size="sm" variant="outline" onClick={() => setAberturaAberta(true)} data-testid="crm-chat-abertura">{t("crm.abertura.iniciar_contato")}</Button>
            )}
          </div>
        </div>
        {vinculada && <p className="text-xs text-muted-foreground" data-testid="crm-chat-janela">{janela}</p>}
      </div>

      {chat.vinculo.tipo === "nenhuma" && <p className="text-sm text-muted-foreground">{t("crm.chat.sem_conversa")}</p>}
      {chat.vinculo.tipo === "a_confirmar" && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p>{t("crm.chat.vinculo_a_confirmar")}</p>
          {!closed && (
            <Button size="sm" disabled={vincularMut.isPending} data-testid="crm-chat-vincular"
              onClick={() => vincularMut.mutate({ id: opportunityId }, { onSuccess: () => { toast.success(t("crm.vinculo.confirmado")); refresh(); }, onError })}>
              {t("crm.vinculo.confirmar")}
            </Button>
          )}
        </div>
      )}
      {chat.vinculo.tipo === "bloqueada" && (
        <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p>{t(`crm.chat.bloqueada.${chat.vinculo.motivo ?? "telefone_invalido"}` as TranslationKey)}</p>
          {chat.vinculo.motivo === "sem_telefone" && chat.celularInformadoNaoGravado && (
            <p data-testid="crm-chat-celular-nao-gravado">{t("crm.sem_telefone.conferencia")}</p>
          )}
          {chat.vinculo.motivo === "telefone_em_varias_fichas" && chat.fichasComMesmoTelefone.length > 0 && (
            <FichasMesmoTelefone fichas={chat.fichasComMesmoTelefone} pessoaId={chat.pessoaId} />
          )}
        </div>
      )}

      {vinculada && (
        <>
          <div
            ref={listaRef}
            onScroll={() => {
              const el = listaRef.current;
              if (el) grudadoNoFimRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="min-h-[200px] flex-1 space-y-2 overflow-y-auto rounded-md border bg-muted/20 p-3"
            data-testid="crm-chat-mensagens"
          >
            {chat.mensagens.length === 0
              ? <p className="text-sm italic text-muted-foreground">{t("crm.chat.vazio")}</p>
              : chat.mensagens.map(m => (
                <Bolha key={m.id} mensagem={m} destacar={m.anexo ? destacados.has(m.anexo.id) || m.anexo.naoVisto : false} onRecopiado={refresh} />
              ))}
          </div>

          <div
            className={`space-y-2 rounded-md ${arrastando ? "outline outline-2 outline-dashed outline-primary" : ""}`}
            data-testid="crm-chat-compositor"
            onDragEnter={e => { if (podeAnexar && temArquivos(e)) { e.preventDefault(); setArrastando(true); } }}
            onDragOver={e => { if (podeAnexar && temArquivos(e)) e.preventDefault(); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setArrastando(false); }}
            onDrop={e => { if (podeAnexar) aoSoltar(e); else setArrastando(false); }}
          >
            {arrastando && <p className="text-center text-xs font-medium text-primary" data-testid="crm-chat-soltar">{t("anexo.soltar")}</p>}

            {fila.length > 0 && (
              <ul className="space-y-2" aria-label={t("anexo.fila")} data-testid="crm-chat-fila">
                {fila.map(item => (
                  <li key={item.chave} className="space-y-1.5 rounded-md border bg-background p-2" data-testid={`crm-chat-fila-item-${item.chave}`}>
                    <div className="flex items-start gap-2">
                      {item.previa
                        ? <img src={item.previa} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
                        : <FileText className="h-8 w-8 shrink-0 text-muted-foreground" />}
                      <div className="min-w-0 flex-1 text-xs">
                        <p className="truncate font-medium" title={item.arquivo.name}>{item.arquivo.name}</p>
                        <p className="text-muted-foreground">{t(`anexo.tipo.${item.tipo}` as TranslationKey)} · {tamanhoLegivel(item.arquivo.size)}</p>
                      </div>
                      <Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={enviandoArquivos}
                        aria-label={t("anexo.remover")} title={t("anexo.remover")} data-testid={`crm-chat-fila-remover-${item.chave}`}
                        onClick={() => removerDaFila(item.chave)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    {item.tipo === "audio" ? (
                      <p className="text-[11px] text-muted-foreground">{t("anexo.legenda_audio")}</p>
                    ) : (
                      <Input
                        value={item.legenda}
                        onChange={e => alterarLegenda(item.chave, e.target.value)}
                        maxLength={LIMITE_LEGENDA}
                        placeholder={t("anexo.legenda")}
                        aria-label={t("anexo.legenda")}
                        disabled={enviandoArquivos}
                        className="h-8 text-xs"
                        data-testid={`crm-chat-fila-legenda-${item.chave}`}
                      />
                    )}
                    {item.erro && <p className="text-[11px] text-destructive" data-testid={`crm-chat-fila-erro-${item.chave}`}>{item.erro}</p>}
                  </li>
                ))}
              </ul>
            )}

            <Textarea
              value={texto}
              onChange={e => setTexto(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar(); } }}
              onPaste={aoColar}
              rows={3}
              maxLength={LIMITE_MENSAGEM}
              disabled={!chat.podeEnviarTexto}
              placeholder={t("crm.chat.placeholder")}
              aria-label={t("crm.chat.placeholder")}
              data-testid="crm-chat-texto"
            />
            <div className="flex items-start justify-between gap-3">
              <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="crm-chat-bloqueios">
                {chat.bloqueiosDeTexto.map(b => <li key={b}>{t(`crm.chat.bloqueio.${b}` as TranslationKey)}</li>)}
              </ul>
              <div className="flex shrink-0 items-center gap-2">
                <input
                  ref={seletorRef}
                  type="file"
                  multiple
                  className="hidden"
                  data-testid="crm-chat-arquivo-input"
                  onChange={e => { adicionarArquivos(Array.from(e.target.files ?? [])); e.target.value = ""; }}
                />
                <Button type="button" size="sm" variant="outline" disabled={!podeAnexar} onClick={() => seletorRef.current?.click()}
                  aria-label={t("anexo.anexar")} title={t("anexo.anexar")} data-testid="crm-chat-anexar">
                  <Paperclip className="mr-1.5 h-3.5 w-3.5" />{t("anexo.anexar")}
                </Button>
                {fila.length > 0 && (
                  <Button type="button" size="sm" disabled={!podeAnexar || fila.some(i => i.erro !== null && erroDeTamanho(i.arquivo, i.tipo) !== null)}
                    onClick={() => void enviarArquivos(fila)} data-testid="crm-chat-enviar-arquivos">
                    <Send className="mr-1.5 h-3.5 w-3.5" />{enviandoArquivos ? t("anexo.enviando") : t("anexo.enviar_arquivo")}
                  </Button>
                )}
                <Button size="sm" onClick={enviar} disabled={!chat.podeEnviarTexto || !texto.trim() || enviarMut.isPending} data-testid="crm-chat-enviar">
                  <Send className="mr-1.5 h-3.5 w-3.5" />{t("crm.chat.enviar")}
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground" data-testid="crm-chat-limites">{t("anexo.limites")}</p>
          </div>
        </>
      )}

      <AberturaModeloDialog open={aberturaAberta} onOpenChange={setAberturaAberta} controller={abertura} onSent={refresh} onLinked={refresh} />
    </div>
  );
}
