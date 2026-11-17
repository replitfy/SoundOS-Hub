import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle, Download, FileText, Loader2, Play, RefreshCw } from "lucide-react";
import { getAttachmentFile, useRetryAttachmentCopy, type MessageAttachment } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useLang, type TranslationKey } from "@/contexts/language";

type Carga = { status: "ocioso" | "carregando" | "pronto" | "erro"; url: string | null };

/**
 * Busca o arquivo de um anexo com a sessão do usuário e o entrega como endereço local (blob). O arquivo
 * nunca tem endereço público: só a rota autenticada o devolve.
 */
export function useArquivoDoAnexo(id: number) {
  const [carga, setCarga] = useState<Carga>({ status: "ocioso", url: null });
  const urlRef = useRef<string | null>(null);
  const vivoRef = useRef(true);

  useEffect(() => {
    vivoRef.current = true;
    return () => {
      vivoRef.current = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  const carregar = useCallback(async (): Promise<string | null> => {
    if (urlRef.current) return urlRef.current;
    setCarga({ status: "carregando", url: null });
    try {
      const blob = await getAttachmentFile(id);
      if (!(blob instanceof Blob)) throw new Error("sem arquivo");
      if (urlRef.current) return urlRef.current; // outra chamada terminou antes
      const url = URL.createObjectURL(blob);
      if (!vivoRef.current) {
        URL.revokeObjectURL(url);
        return null;
      }
      urlRef.current = url;
      setCarga({ status: "pronto", url });
      return url;
    } catch {
      if (vivoRef.current) setCarga({ status: "erro", url: null });
      return null;
    }
  }, [id]);

  return { carga, carregar };
}

/** Tamanho legível (KB/MB) para a tela. */
export function tamanhoLegivel(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

interface Props {
  anexo: MessageAttachment;
  /** Realça o arquivo que ninguém da equipe tinha visto quando a conversa foi aberta. */
  destacar?: boolean;
  /** Depois de pedir nova cópia: a tela recarrega a conversa. */
  onRecopiado?: () => void;
}

function Cartao({ anexo, destacar, children }: { anexo: MessageAttachment; destacar?: boolean; children: ReactNode }) {
  return (
    <div
      className={`rounded-md border bg-background p-2 text-sm text-foreground ${destacar ? "border-amber-500 ring-2 ring-amber-400/60" : "border-border"}`}
      data-testid={`anexo-${anexo.id}`}
      data-copia={anexo.copia}
      data-tipo={anexo.tipo}
      data-novo={destacar ? "true" : undefined}
    >
      {children}
    </div>
  );
}

function Selo({ anexo, destacar }: { anexo: MessageAttachment; destacar?: boolean }) {
  const { t } = useLang();
  const tamanho = tamanhoLegivel(anexo.tamanhoBytes);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
      <span className="font-medium">{t(`anexo.tipo.${anexo.tipo}` as TranslationKey)}</span>
      {anexo.nome && <span className="max-w-[220px] truncate" title={anexo.nome}>{anexo.nome}</span>}
      {tamanho && <span>{tamanho}</span>}
      {destacar && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200" data-testid={`anexo-novo-${anexo.id}`}>
          {t("anexo.novo")}
        </span>
      )}
    </div>
  );
}

function motivoTraduzido(motivo: string | null, t: (k: TranslationKey) => string): string | null {
  if (!motivo) return null;
  const chave = `anexo.motivo.${motivo}` as TranslationKey;
  const texto = t(chave);
  return texto === chave ? null : texto;
}

function Conteudo({ anexo }: { anexo: MessageAttachment }) {
  const { t } = useLang();
  const { carga, carregar } = useArquivoDoAnexo(anexo.id);

  // Imagem aparece sozinha; vídeo, áudio e documento só são buscados quando a pessoa pede (arquivos grandes).
  useEffect(() => {
    if (anexo.tipo === "image") void carregar();
  }, [anexo.tipo, carregar]);

  const baixar = async () => {
    const url = await carregar();
    if (!url) { toast.error(t("anexo.erro_abrir")); return; }
    const link = document.createElement("a");
    link.href = url;
    link.download = anexo.nome ?? `arquivo-${anexo.id}`;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const carregando = carga.status === "carregando";
  const erro = carga.status === "erro";

  return (
    <div className="space-y-1.5">
      {anexo.tipo === "image" && (
        carga.url ? (
          <a href={carga.url} target="_blank" rel="noopener noreferrer" data-testid={`anexo-abrir-${anexo.id}`}>
            <img src={carga.url} alt={t("anexo.alt_imagem")} className="max-h-64 max-w-full rounded object-contain" />
          </a>
        ) : carregando ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("anexo.carregando")}</p>
        ) : null
      )}
      {anexo.tipo === "video" && (
        carga.url ? (
          <video src={carga.url} controls preload="metadata" className="max-h-64 max-w-full rounded" data-testid={`anexo-video-${anexo.id}`} />
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={carregando} onClick={() => void carregar()} data-testid={`anexo-carregar-${anexo.id}`}>
            {carregando ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
            {t("anexo.carregar_video")}
          </Button>
        )
      )}
      {anexo.tipo === "audio" && (
        carga.url ? (
          <audio src={carga.url} controls preload="metadata" className="max-w-full" data-testid={`anexo-audio-${anexo.id}`} />
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={carregando} onClick={() => void carregar()} data-testid={`anexo-carregar-${anexo.id}`}>
            {carregando ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
            {t("anexo.carregar_audio")}
          </Button>
        )
      )}
      {anexo.tipo === "document" && (
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <Button type="button" size="sm" variant="outline" disabled={carregando} onClick={() => void baixar()} data-testid={`anexo-baixar-${anexo.id}`}>
            {carregando ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
            {t("anexo.baixar")}
          </Button>
        </div>
      )}
      {erro && <p className="text-xs text-destructive" data-testid={`anexo-erro-${anexo.id}`}>{t("anexo.erro_abrir")}</p>}
    </div>
  );
}

/** Arquivo de uma mensagem do WhatsApp (imagem, vídeo, áudio ou documento) com os estados da cópia. */
export function AnexoDaMensagem({ anexo, destacar, onRecopiado }: Props) {
  const { t } = useLang();
  const recopiar = useRetryAttachmentCopy();
  const motivo = motivoTraduzido(anexo.motivo, t);

  if (anexo.copia === "copiado") {
    return (
      <Cartao anexo={anexo} destacar={destacar}>
        <Selo anexo={anexo} destacar={destacar} />
        <div className="mt-1.5"><Conteudo anexo={anexo} /></div>
      </Cartao>
    );
  }

  if (anexo.copia === "pendente") {
    return (
      <Cartao anexo={anexo} destacar={destacar}>
        <Selo anexo={anexo} destacar={destacar} />
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("anexo.copiando")}</p>
      </Cartao>
    );
  }

  const indisponivel = anexo.copia === "indisponivel";
  return (
    <Cartao anexo={anexo} destacar={destacar}>
      <Selo anexo={anexo} destacar={destacar} />
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive" data-testid={`anexo-estado-${anexo.id}`}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {indisponivel ? t("anexo.indisponivel") : t("anexo.recusado")}
      </p>
      {motivo && <p className="text-[11px] text-muted-foreground" data-testid={`anexo-motivo-${anexo.id}`}>{t("anexo.motivo")}: {motivo}</p>}
      {indisponivel && anexo.podeRecopiar && (
        <Button
          type="button" size="sm" variant="outline" className="mt-1.5"
          disabled={recopiar.isPending}
          data-testid={`anexo-recopiar-${anexo.id}`}
          onClick={() => recopiar.mutate({ id: anexo.id }, {
            onSuccess: () => { toast.success(t("anexo.recopiar_ok")); onRecopiado?.(); },
            onError: () => { toast.error(t("anexo.recopiar_erro")); onRecopiado?.(); },
          })}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${recopiar.isPending ? "animate-spin" : ""}`} />{t("anexo.recopiar")}
        </Button>
      )}
    </Cartao>
  );
}
