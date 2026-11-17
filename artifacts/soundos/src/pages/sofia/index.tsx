import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Bot, Send, User, Sparkles, Plus, Phone, Users, RefreshCw, Brain, AlertTriangle } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { useAccess } from "@/contexts/access";
import { useToast } from "@/hooks/use-toast";
import {
  useGetConversation, getGetConversationQueryKey,
  useListConversationDecisionRuns, getListConversationDecisionRunsQueryKey,
  getListConversationsAwaitingStaffQueryKey, getListConversationsQueryKey,
  markConversationAttachmentsSeen,
  type MessageAttachment,
} from "@workspace/api-client-react";
import { AnexoDaMensagem } from "@/components/anexo-da-mensagem";
import DecisionRunsPanel from "./decision-runs-panel";
import { getSofiaModelLabel } from "@/lib/sofia-models";

interface ChatMessage {
  /** id da linha em `messages` — liga a mensagem à decisão que a produziu. */
  id?: number;
  role: "user" | "sofia";
  text: string;
  streaming?: boolean;
  /** Resposta que não chegou ao cliente (canal externo, ex.: Instagram). */
  envioFalhou?: boolean;
  envioErro?: string | null;
  /** Estado da entrega pelo canal externo (aceito, enviado, entregue, lido ou falhou). */
  envioStatus?: string | null;
  /** Mensagem escrita pela equipe (ou modelo de abertura enviado pela equipe): não é da Sofia. */
  equipe?: { nome: string | null; modeloAbertura: boolean };
  /** Arquivo da mensagem (WhatsApp): o texto, se houver, é a legenda. */
  anexo?: MessageAttachment | null;
}

const HANDOFF_ACTIVE_STATUSES = new Set(["aguardando_humano", "atendimento_humano"]);

const COUNTRY_CODES = [
  { code: "+55", flag: "🇧🇷", label: "🇧🇷 +55" },
  { code: "+1", flag: "🇺🇸", label: "🇺🇸 +1" },
  { code: "+351", flag: "🇵🇹", label: "🇵🇹 +351" },
  { code: "+54", flag: "🇦🇷", label: "🇦🇷 +54" },
  { code: "+598", flag: "🇺🇾", label: "🇺🇾 +598" },
  { code: "+56", flag: "🇨🇱", label: "🇨🇱 +56" },
  { code: "+52", flag: "🇲🇽", label: "🇲🇽 +52" },
];

// URLs que a Sofia manda (vídeos recomendados, etc.) vinham como texto puro —
// o usuário precisa poder clicar em vez de copiar/colar manualmente.
const URL_PATTERN = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function renderWithBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <strong key={i}>{part.slice(1, -1)}</strong>;
    }
    if (URL_PATTERN.test(part)) {
      URL_PATTERN.lastIndex = 0;
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:opacity-80 break-all"
        >
          {part}
        </a>
      );
    }
    return part ? <span key={i}>{part}</span> : null;
  });
}

function formatBRPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 11);
  if (digits.length === 0) return "";
  if (digits.length <= 2) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

export default function SofiaChat() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const convParam = params.get("conv");
  const pessoaParam = params.get("pessoa");
  const initialConvId = convParam ? parseInt(convParam, 10) : null;
  const linkedPessoaId = pessoaParam ? parseInt(pessoaParam, 10) : null;

  const queryClient = useQueryClient();
  const { authHeader } = useUserSession();
  const { isAdmin, can } = useAccess();
  const podeVerConversas = can("conversas");

  const [message, setMessage] = useState("");
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(initialConvId);
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Arquivos que ninguém da equipe tinha visto quando a conversa foi aberta: ficam realçados nesta tela.
  const [anexosNovos, setAnexosNovos] = useState<ReadonlySet<number>>(() => new Set());

  const [pessoaNome, setPessoaNome] = useState("");
  const [pessoaCelular, setPessoaCelular] = useState("");
  const [countryCode, setCountryCode] = useState("+55");
  const [activeModel, setActiveModel] = useState("");
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);
  const [reloadingPrompt, setReloadingPrompt] = useState(false);
  const { t } = useLang();
  const { toast } = useToast();

  const { data: currentConversation } = useGetConversation(conversationId ?? 0, {
    query: { queryKey: getGetConversationQueryKey(conversationId ?? 0), enabled: !!conversationId },
  });

  // Log do motor cognitivo — só busca quando o painel está aberto (e só admin
  // pode ler: o endpoint exige role de administrador).
  const [showDecisionLog, setShowDecisionLog] = useState(false);
  const [hoveredMessageId, setHoveredMessageId] = useState<number | null>(null);
  const focusMessageInChat = useCallback((messageId: number) => {
    setHoveredMessageId(messageId);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-sofia-message-id="${messageId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    window.setTimeout(() => {
      setHoveredMessageId(current => current === messageId ? null : current);
    }, 2_000);
  }, []);

  // O painel pode ser aberto DURANTE um envio; handleSend só enxerga a closure
  // do início do turno, então lê a visibilidade atual por ref.
  const showDecisionLogRef = useRef(showDecisionLog);
  useEffect(() => { showDecisionLogRef.current = showDecisionLog; }, [showDecisionLog]);

  const {
    data: decisionRunsData,
    isLoading: decisionRunsLoading,
    isFetching: decisionRunsFetching,
    isError: decisionRunsError,
    refetch: refetchDecisionRuns,
  } = useListConversationDecisionRuns(conversationId ?? 0, {
    query: {
      queryKey: getListConversationDecisionRunsQueryKey(conversationId ?? 0),
      enabled: showDecisionLog && isAdmin && !!conversationId,
    },
  });

  useEffect(() => {
    if (
      conversationId &&
      currentConversation?.id === conversationId
    ) {
      setHandoffStatus(currentConversation.status ?? null);
    }
  }, [conversationId, currentConversation]);

  const persistedHandoffStatus =
    conversationId && currentConversation?.id === conversationId
      ? currentConversation.status ?? null
      : null;
  const displayedHandoffStatus = handoffStatus ?? persistedHandoffStatus;
  const isHandoffActive =
    displayedHandoffStatus != null &&
    HANDOFF_ACTIVE_STATUSES.has(displayedHandoffStatus);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRequestTokenRef = useRef(0);
  const linkedPersonRequestTokenRef = useRef(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatLog]);

  const fetchActivePrompt = useCallback(async () => {
    const res = await fetch(`/api/sofia/prompts?_=${Date.now()}`, {
      headers: { ...authHeader },
      cache: "no-store",
    });
    const prompts: { isActive: boolean; model: string; name?: string | null; version: string }[] = await res.json();
    const active = prompts.find(p => p.isActive);
    setActiveModel(active?.model ?? "gpt-5.4-mini");
    return active;
  }, [authHeader]);

  useEffect(() => {
    fetchActivePrompt().catch(() => setActiveModel("gpt-5.4-mini"));
  }, [fetchActivePrompt]);

  const handleReloadPrompt = async () => {
    setReloadingPrompt(true);
    try {
      const active = await fetchActivePrompt();
      const label = active ? (active.name && active.name !== active.version ? `${active.name} (${active.version})` : active.version) : undefined;
      toast({
        title: t("sofia.chat.prompt_recarregado"),
        description: active
          ? `${t("sofia.chat.prompt_ativo")}: ${label} — ${t("sofia.chat.modelo_ativo")}: ${getSofiaModelLabel(active.model)}`
          : undefined,
      });
    } catch {
      toast({
        title: t("sofia.chat.prompt_erro_recarregar"),
        variant: "destructive",
      });
    } finally {
      setReloadingPrompt(false);
    }
  };

  // `silent` recarrega o histórico sem trocar a conversa por um spinner —
  // usado após enviar uma mensagem, só para as bolhas ganharem seus ids e
  // poderem ser ligadas às decisões do motor cognitivo.
  const loadHistory = useCallback(async (convId: number, silent = false) => {
    const requestToken = ++historyRequestTokenRef.current;
    if (!silent) setLoadingHistory(true);
    try {
      const res = await fetch(`/api/sofia/conversations/${convId}/messages`, { headers: { ...authHeader } });
      if (!res.ok) return;
      const msgs: { id: number; role: string; content: string; envioStatus?: string | null; envioErro?: string | null; authorName?: string | null; kind?: string | null; anexo?: MessageAttachment | null }[] = await res.json();
      if (requestToken !== historyRequestTokenRef.current) return;
      const naoVistos = msgs.flatMap(m => (m.anexo?.naoVisto ? [m.anexo.id] : []));
      if (naoVistos.length > 0 && podeVerConversas) {
        setAnexosNovos(atuais => new Set([...atuais, ...naoVistos]));
        // Abrir a conversa em Conversas dá os arquivos recebidos como vistos (só aqui e no cartão do CRM).
        void markConversationAttachmentsSeen(convId).then(() => {
          void queryClient.invalidateQueries({ queryKey: getListConversationsAwaitingStaffQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
        }).catch(() => { /* o aviso continua até a próxima abertura */ });
      }
      setChatLog(msgs.map(m => ({
        id: m.id,
        role: m.role === "user" ? "user" : "sofia",
        text: m.content,
        envioFalhou: m.envioStatus === "falhou",
        envioErro: m.envioErro ?? null,
        envioStatus: m.envioStatus ?? null,
        anexo: m.anexo ?? null,
        equipe: m.role === "staff" || m.kind === "modelo_abertura"
          ? { nome: m.authorName ?? null, modeloAbertura: m.kind === "modelo_abertura" }
          : undefined,
      })));
    } catch {
      // ignore
    } finally {
      if (!silent && requestToken === historyRequestTokenRef.current) setLoadingHistory(false);
    }
  }, [authHeader, podeVerConversas, queryClient]);

  useEffect(() => {
    setConversationId(initialConvId);
    setAnexosNovos(new Set());
    setHandoffStatus(null);
    if (!initialConvId) {
      historyRequestTokenRef.current += 1;
      setLoadingHistory(false);
      setChatLog([]);
    }
  }, [initialConvId]);

  useEffect(() => {
    if (initialConvId) void loadHistory(initialConvId);
  }, [initialConvId, loadHistory]);

  // Ao abrir o painel numa conversa já em tela, recarrega o histórico em
  // silêncio: as bolhas enviadas nesta sessão ainda não têm id, e sem id não
  // dá para ligá-las à decisão que as produziu.
  useEffect(() => {
    if (showDecisionLog && conversationId) void loadHistory(conversationId, true);
  }, [showDecisionLog, conversationId, loadHistory]);

  // Pre-fill nome/celular from the linked pessoa so Sofia never uses test defaults
  useEffect(() => {
    const requestToken = ++linkedPersonRequestTokenRef.current;
    if (!linkedPessoaId) return;
    fetch(`/api/pessoas/${linkedPessoaId}`, { headers: { ...authHeader } })
      .then(r => r.ok ? r.json() : null)
      .then((p: { nome?: string; sobrenome?: string | null; celular?: string | null } | null) => {
        if (!p || requestToken !== linkedPersonRequestTokenRef.current) return;
        const fullName = [p.nome, p.sobrenome].filter(Boolean).join(" ");
        if (fullName) setPessoaNome(fullName);
        if (p.celular) {
          // Strip country code prefix if it matches our selector options
          const raw = p.celular.replace(/^\+\d{1,3}\s*/, "");
          setPessoaCelular(raw);
          // Detect country code
          const match = p.celular.match(/^(\+\d{1,3})/);
          if (match) setCountryCode(match[1]);
        }
      })
      .catch(() => { /* silent — keep defaults */ });
  }, [linkedPessoaId]);

  const handleNewConversation = () => {
    const previousConversationId = conversationId;
    historyRequestTokenRef.current += 1;
    linkedPersonRequestTokenRef.current += 1;
    setConversationId(null);
    setChatLog([]);
    setMessage("");
    setHandoffStatus(null);
    setLoadingHistory(false);
    setPessoaNome("");
    setPessoaCelular("");
    setCountryCode("+55");
    setShowDecisionLog(false);
    setHoveredMessageId(null);
    if (previousConversationId) {
      void queryClient.cancelQueries({
        queryKey: getGetConversationQueryKey(previousConversationId),
      });
      void queryClient.cancelQueries({
        queryKey: getListConversationDecisionRunsQueryKey(previousConversationId),
      });
    }
    navigate("/sofia", { replace: true });
    inputRef.current?.focus();
  };

  const handleSend = async () => {
    const text = message.trim();
    if (!text || isStreaming || isHandoffActive) return;

    // Sem nome/celular a conversa é anônima: nada de identidade de teste padrão.
    const nome = pessoaNome.trim();
    const celularLocal = pessoaCelular.trim();
    const fullCelular = celularLocal ? `${countryCode} ${celularLocal}` : "";

    setMessage("");
    setChatLog(prev => [...prev, { role: "user", text }]);
    setIsStreaming(true);
    setChatLog(prev => [...prev, { role: "sofia", text: "", streaming: true }]);

    // A conversa pode ser criada durante o stream; guardamos o id resolvido
    // para atualizar o log de decisões quando o turno terminar.
    let streamConvId = conversationId;

    try {
      const response = await fetch("/api/sofia/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          message: text,
          conversationId: conversationId ?? undefined,
          ...(nome ? { pessoaNome: nome } : {}),
          ...(fullCelular ? { pessoaCelular: fullCelular } : {}),
          ...(linkedPessoaId ? { pessoaId: linkedPessoaId } : {}),
        }),
      });

      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const json = JSON.parse(line.slice(6));
            if (json.content) {
              setChatLog(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "sofia") {
                  updated[updated.length - 1] = { ...last, text: last.text + json.content, streaming: true };
                }
                return updated;
              });
            }
            if (json.done) {
              setChatLog(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "sofia") {
                  updated[updated.length - 1] = { ...last, streaming: false };
                }
                return updated;
              });
              if (json.conversationId && !conversationId) {
                setConversationId(json.conversationId);
                const newUrl = linkedPessoaId
                  ? `${window.location.pathname}?pessoa=${linkedPessoaId}&conv=${json.conversationId}`
                  : `${window.location.pathname}?conv=${json.conversationId}`;
                window.history.replaceState(null, "", newUrl);
                if (linkedPessoaId) {
                  void queryClient.invalidateQueries({ queryKey: ["/api/pessoas", linkedPessoaId, "conversations"] });
                  void queryClient.invalidateQueries({ queryKey: ["/api/pessoas"] });
                }
              }
              if (json.handoffTriggered) {
                setHandoffStatus("aguardando_humano");
              }
              if (json.handoffActive && json.handoffStatus) {
                setHandoffStatus(json.handoffStatus);
              }
              if (json.conversationId) {
                streamConvId = json.conversationId;
                void queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(json.conversationId) });
                void queryClient.invalidateQueries({ queryKey: ["/api/sofia/conversations"] });
              }
            }
            if (json.error) {
              setChatLog(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "sofia") {
                  updated[updated.length - 1] = { ...last, text: `${t("sofia.chat.err_prefixo")} ${json.error}`, streaming: false };
                }
                return updated;
              });
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch {
      setChatLog(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "sofia") {
          updated[updated.length - 1] = {
            ...last,
            text: t("sofia.chat.err_conexao"),
            streaming: false,
          };
        }
        return updated;
      });
    } finally {
      if (showDecisionLogRef.current && streamConvId) {
        void queryClient.invalidateQueries({ queryKey: getListConversationDecisionRunsQueryKey(streamConvId) });
        // Recarrega ANTES de liberar o input: se o atendente já pudesse enviar
        // a próxima mensagem, esta resposta atrasada sobrescreveria o histórico.
        await loadHistory(streamConvId, true);
      }
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 h-full flex flex-col max-h-[90vh]">
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("sofia.chat.title")}</h1>
          <p className="text-muted-foreground flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-sofia" />
            {t("sofia.chat.subtitle")} {activeModel ? getSofiaModelLabel(activeModel) : "..."}
          </p>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReloadPrompt}
            className="flex items-center gap-1.5"
            disabled={reloadingPrompt}
            title={t("sofia.chat.recarregar_prompt")}
          >
            <RefreshCw className={`h-4 w-4 ${reloadingPrompt ? "animate-spin" : ""}`} />
            {t("sofia.chat.recarregar_prompt")}
          </Button>
          {isAdmin && (
            <Button
              variant={showDecisionLog ? "default" : "outline"}
              size="sm"
              onClick={() => setShowDecisionLog(v => !v)}
              className={`flex items-center gap-1.5 ${showDecisionLog ? "bg-sofia hover:bg-sofia/90" : ""}`}
              title="Abrir o log de decisões do motor cognitivo desta conversa"
              data-testid="button-motor-cognitivo"
            >
              <Brain className="h-4 w-4" />
              Motor Cognitivo
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewConversation}
            data-testid="button-new-conversation"
            className="flex items-center gap-1.5"
            disabled={isStreaming}
          >
            <Plus className="h-4 w-4" />
            {t("sofia.chat.nova")}
          </Button>
        </div>
      </div>

      {isHandoffActive && (
        <div
          data-testid="sofia-handoff-banner"
          className="shrink-0 flex items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800/60 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
        >
          <Users className="h-4 w-4 shrink-0" />
          <span>
            {displayedHandoffStatus === "atendimento_humano" ? t("sofia.conv.status.atendimento") : t("sofia.conv.status.aguardando")}
            {" — "}{t("sofia.chat.handoff_ativo")}
          </span>
        </div>
      )}

      {/* Identification panel */}
      <Card className="shrink-0 shadow-sm border-border/50">
        <CardContent className="py-3 px-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                <User className="h-3 w-3" /> {t("sofia.chat.nome_usuario")}
              </Label>
              <Input
                value={pessoaNome}
                onChange={e => setPessoaNome(e.target.value)}
                placeholder="Ex.: Ana Souza"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                <Phone className="h-3 w-3" /> {t("common.celular")}
              </Label>
              <div className="flex gap-1">
                <select
                  value={countryCode}
                  onChange={e => setCountryCode(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring shrink-0"
                >
                  {COUNTRY_CODES.map(c => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
                <Input
                  value={pessoaCelular}
                  onChange={e => setPessoaCelular(formatBRPhone(e.target.value))}
                  placeholder="(DDD) 9XXXX-XXXX"
                  className="h-8 text-sm flex-1"
                />
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/60 mt-1.5">
            {t("sofia.chat.padrao_teste")}
          </p>
        </CardContent>
      </Card>

      <div className="flex-1 flex flex-col lg:flex-row gap-4 overflow-hidden min-h-0">
      {/* Chat card */}
      <Card className="shadow-sm border-border/50 flex-1 flex flex-col overflow-hidden">
        <CardHeader className="border-b border-border/50 bg-muted/20 py-3 shrink-0">
          <CardTitle className="text-xs font-bold tracking-[0.14em] uppercase text-muted-foreground flex items-center gap-2">
            <Bot className="h-4 w-4 text-sofia" /> {t("sofia.chat.assistente")}
            {conversationId && (
              <span className="ml-auto text-[10px] font-normal normal-case text-muted-foreground/60">
                #conv{conversationId}
              </span>
            )}
          </CardTitle>
        </CardHeader>

        <CardContent className="p-4 flex-1 overflow-y-auto flex flex-col gap-4">
          {loadingHistory ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 bg-sofia rounded-full animate-bounce" />
                <span className="w-2 h-2 bg-sofia rounded-full animate-bounce [animation-delay:0.2s]" />
                <span className="w-2 h-2 bg-sofia rounded-full animate-bounce [animation-delay:0.4s]" />
              </span>
            </div>
          ) : chatLog.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm flex-col gap-3">
              <div className="w-14 h-14 rounded-full bg-sofia/10 flex items-center justify-center">
                <Bot className="h-7 w-7 text-sofia" />
              </div>
              <div className="text-center">
                <p className="font-medium text-foreground/70 mb-1">{t("sofia.chat.ola")}</p>
                <p className="text-xs">{t("sofia.chat.assistente_ia")}</p>
              </div>
            </div>
          ) : (
            chatLog.map((msg, i) => {
              const isLinked = hoveredMessageId != null && msg.id === hoveredMessageId;
              return (
              <div
                key={i}
                data-sofia-message-id={msg.id}
                data-testid={msg.id != null ? `chat-message-${msg.id}` : undefined}
                onMouseEnter={() => { if (showDecisionLog && msg.id != null) setHoveredMessageId(msg.id); }}
                onMouseLeave={() => { if (showDecisionLog) setHoveredMessageId(null); }}
                className={`flex gap-3 ${msg.role === "user" ? "self-end flex-row-reverse max-w-[80%]" : "self-start max-w-[85%]"}`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    msg.role === "user" ? "bg-primary text-primary-foreground" : msg.equipe ? "bg-primary/20 text-primary" : "bg-sofia text-white"
                  }`}
                >
                  {msg.role === "user" || msg.equipe ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                </div>
                <div
                  className={`p-3 rounded-2xl transition-all ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-tr-sm"
                      : msg.equipe
                        ? "bg-primary/10 border border-primary/30 text-foreground rounded-tl-sm"
                        : "bg-muted text-foreground rounded-tl-sm"
                  } ${isLinked ? "ring-2 ring-sofia ring-offset-2 ring-offset-background" : ""}`}
                >
                  {msg.equipe && (
                    <p className="text-[11px] font-medium text-muted-foreground mb-1" data-testid={`text-autor-equipe-${msg.id}`}>
                      {msg.equipe.modeloAbertura ? `${t("crm.chat.modelo_abertura")} · ` : `${t("crm.chat.equipe")} · `}
                      {msg.equipe.nome ?? t("crm.ator.desconhecido")}
                    </p>
                  )}
                  {msg.anexo && (
                    <div className={msg.text ? "mb-2" : ""}>
                      <AnexoDaMensagem
                        anexo={msg.anexo}
                        destacar={anexosNovos.has(msg.anexo.id)}
                        onRecopiado={() => { if (conversationId) void loadHistory(conversationId, true); }}
                      />
                    </div>
                  )}
                  {msg.text ? (
                    <p className="text-sm whitespace-pre-wrap">{renderWithBold(msg.text)}</p>
                  ) : msg.streaming ? (
                    <span className="flex items-center gap-1 py-0.5">
                      <span className="w-2 h-2 bg-sofia rounded-full animate-bounce" />
                      <span className="w-2 h-2 bg-sofia rounded-full animate-bounce [animation-delay:0.2s]" />
                      <span className="w-2 h-2 bg-sofia rounded-full animate-bounce [animation-delay:0.4s]" />
                    </span>
                  ) : null}
                  {msg.streaming && msg.text && (
                    <span className="inline-block w-0.5 h-4 bg-sofia/70 animate-pulse ml-0.5 align-middle" />
                  )}
                  {!msg.envioFalhou && currentConversation?.canal === "whatsapp" && (msg.role === "sofia" || msg.equipe) && msg.envioStatus && (
                    <p className="text-[11px] text-muted-foreground mt-1.5" data-testid={`text-envio-estado-${msg.id}`}>
                      {t(`sofia.wa.entrega.${msg.envioStatus}` as Parameters<typeof t>[0])}
                    </p>
                  )}
                  {msg.envioFalhou && (
                    <p className="flex items-center gap-1 text-xs text-destructive mt-1.5" title={msg.envioErro ?? undefined} data-testid={`text-envio-falhou-${msg.id}`}>
                      <AlertTriangle className="h-3 w-3 shrink-0" />{t("sofia.conv.envio_falhou")}
                    </p>
                  )}
                  {msg.envioFalhou && msg.envioErro && (
                    <p className="text-[11px] text-destructive mt-0.5" data-testid={`text-envio-erro-${msg.id}`}>{msg.envioErro}</p>
                  )}
                </div>
              </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </CardContent>

        <div className="p-4 border-t border-border/50 bg-background flex gap-2 shrink-0">
          <Input
            ref={inputRef}
            data-testid="sofia-message-input"
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder={t("sofia.chat.placeholder")}
            onKeyDown={e => e.key === "Enter" && handleSend()}
            disabled={isStreaming || loadingHistory || isHandoffActive}
            className="flex-1"
          />
          <Button
            onClick={handleSend}
            disabled={isStreaming || !message.trim() || loadingHistory || isHandoffActive}
            className="bg-sofia hover:bg-sofia/90"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </Card>

      {isAdmin && showDecisionLog && (
        <DecisionRunsPanel
          runs={decisionRunsData}
          isLoading={decisionRunsLoading}
          isFetching={decisionRunsFetching}
          isError={decisionRunsError}
          onRefresh={() => refetchDecisionRuns()}
          hoveredMessageId={hoveredMessageId}
          onHoverMessage={setHoveredMessageId}
          onFocusMessage={focusMessageInChat}
          onClose={() => setShowDecisionLog(false)}
        />
      )}
      </div>
    </div>
  );
}
