import { useState } from "react";
import { toast } from "sonner";
import { ShieldCheck, ShieldOff } from "lucide-react";
import type { ContactRegistrationInput, ContactState } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLang, type TranslationKey } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { errorText } from "../atendimento-errors";

type Origem = NonNullable<ContactRegistrationInput["origem"]>;
type Tipo = ContactRegistrationInput["kind"];

const ORIGENS: Origem[] = ["FORMULARIO", "CONVERSA_WHATSAPP", "PRESENCIAL", "OUTRO"];
const LIMITE_ORIGEM = 300;

interface Props {
  /** `undefined` enquanto carrega. */
  estado: ContactState | undefined;
  /** Registra e recarrega; recusado pelo servidor vira erro (mostrado aqui). */
  onRegister: (input: ContactRegistrationInput) => Promise<unknown>;
  pending: boolean;
  /** Cartão encerrado: só leitura. */
  readOnly?: boolean;
}

/**
 * Autorização para contato por WhatsApp. O registro só cresce (quem registrou, quando e de onde veio) e o
 * estado atual é derivado dele; "não quer receber" sempre vence a autorização.
 */
export function ContatoAutorizacao({ estado, onRegister, pending, readOnly = false }: Props) {
  const { t } = useLang();
  const [tipo, setTipo] = useState<Tipo | null>(null);
  const [origem, setOrigem] = useState<Origem>("CONVERSA_WHATSAPP");
  const [origemTexto, setOrigemTexto] = useState("");
  const [verTodos, setVerTodos] = useState(false);

  if (!estado) return <p className="text-sm text-muted-foreground">{t("crm.contato.carregando")}</p>;

  const confirmar = async () => {
    if (!tipo) return;
    if (tipo !== "NAO_QUER_RECEBER_DESFEITO" && origem === "OUTRO" && !origemTexto.trim()) return;
    try {
      await onRegister(tipo === "NAO_QUER_RECEBER_DESFEITO"
        ? { kind: tipo }
        : { kind: tipo, origem, origemTexto: origemTexto.trim() || null });
      toast.success(t("crm.contato.registrado"));
      setTipo(null);
      setOrigemTexto("");
    } catch (err) {
      toast.error(errorText(err, t));
    }
  };

  const registros = verTodos ? estado.registros : estado.registros.slice(0, 3);
  const pedeOrigem = tipo === "AUTORIZOU" || tipo === "NAO_QUER_RECEBER";

  return (
    <section className="space-y-3" data-testid="crm-contato">
      <h3 className="text-sm font-bold tracking-widest text-muted-foreground uppercase">{t("crm.contato.titulo")}</h3>

      {estado.naoQuerReceber ? (
        <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive" data-testid="crm-contato-estado">
          <ShieldOff className="h-4 w-4 shrink-0" />{t("crm.contato.estado.nao_quer_receber")}
        </p>
      ) : estado.autorizado ? (
        <p className="flex items-center gap-2 rounded-md border border-green-600/30 bg-green-600/10 p-2 text-sm text-green-700" data-testid="crm-contato-estado">
          <ShieldCheck className="h-4 w-4 shrink-0" />{t("crm.contato.estado.autorizado")}
        </p>
      ) : (
        <p className="rounded-md border bg-muted/40 p-2 text-sm text-muted-foreground" data-testid="crm-contato-estado">{t("crm.contato.estado.sem_registro")}</p>
      )}

      {!readOnly && tipo === null && (
        <div className="flex flex-wrap gap-2">
          {!estado.autorizado && (
            <Button size="sm" variant="outline" onClick={() => setTipo("AUTORIZOU")} data-testid="crm-contato-autorizar">{t("crm.contato.registrar_autorizacao")}</Button>
          )}
          {estado.naoQuerReceber ? (
            <Button size="sm" variant="outline" onClick={() => setTipo("NAO_QUER_RECEBER_DESFEITO")} data-testid="crm-contato-desfazer">{t("crm.contato.desfazer_nao_quer")}</Button>
          ) : (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => setTipo("NAO_QUER_RECEBER")} data-testid="crm-contato-nao-quer">{t("crm.contato.registrar_nao_quer")}</Button>
          )}
        </div>
      )}

      {!readOnly && tipo !== null && (
        <div className="space-y-2 rounded-md border p-3" data-testid="crm-contato-form">
          <p className="text-sm font-medium">{t(`crm.contato.confirma.${tipo}` as TranslationKey)}</p>
          {pedeOrigem && (
            <>
              <label className="text-xs font-medium">{t("crm.contato.origem")}</label>
              <Select value={origem} onValueChange={v => setOrigem(v as Origem)}>
                <SelectTrigger aria-label={t("crm.contato.origem")}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ORIGENS.map(o => <SelectItem key={o} value={o}>{t(`crm.contato.origem.${o}` as TranslationKey)}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input value={origemTexto} onChange={e => setOrigemTexto(e.target.value)} maxLength={LIMITE_ORIGEM}
                placeholder={origem === "OUTRO" ? t("crm.contato.origem_texto_obrigatorio") : t("crm.contato.origem_texto")}
                aria-label={t("crm.contato.origem_texto")} />
            </>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={confirmar} disabled={pending || (pedeOrigem && origem === "OUTRO" && !origemTexto.trim())} data-testid="crm-contato-confirmar">{t("common.confirmar")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setTipo(null)}>{t("common.cancelar")}</Button>
          </div>
        </div>
      )}

      {estado.registros.length > 0 && (
        <div className="space-y-1">
          <ul className="space-y-1 text-xs text-muted-foreground" data-testid="crm-contato-registros">
            {registros.map(r => (
              <li key={r.id}>
                <span className="font-medium text-foreground">{t(`crm.contato.kind.${r.kind}` as TranslationKey)}</span>
                {" · "}{t(`crm.contato.origem.${r.origem}` as TranslationKey)}{r.origemTexto ? ` (${r.origemTexto})` : ""}
                {" · "}{r.registradoPeloSistema ? t("crm.contato.autor_automatico") : (r.registradoPorNome ?? t("crm.ator.desconhecido"))}{" · "}{formatDateTimeBR(r.createdAt)}
              </li>
            ))}
          </ul>
          {estado.registros.length > 3 && (
            <button type="button" className="text-xs text-primary underline" onClick={() => setVerTodos(v => !v)}>
              {verTodos ? t("crm.contato.ver_menos") : t("crm.contato.ver_todos")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
