import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Check } from "lucide-react";
import { parseCor } from "@/lib/interesse-embed";
import "./interesse-geral.css";

interface GroupInfo { slug: string; label: string; cor: string; corTexto: string }
interface FormDefinition { grupo: GroupInfo | null; consentimento?: { texto: string } }

const FIELD_ORDER = ["nome", "celular", "instagram", "email"] as const;
type FieldKey = (typeof FIELD_ORDER)[number];

const DEFAULT_ACCENT = "#CBB98A";
const DEFAULT_ACCENT_TEXT = "#2B2415";

/** Texto do botão com contraste mínimo quando a cor vem do código de embed. */
function readableTextOn(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255, g = (value >> 8) & 255, b = value & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#2B2415" : "#FFFFFF";
}

function BrazilFlag() {
  return (
    <svg className="ig-flag" viewBox="0 0 24 17" role="img" aria-label="Brasil">
      <rect width="24" height="17" fill="#009C3B" />
      <path d="M12 2.2 21.4 8.5 12 14.8 2.6 8.5Z" fill="#FFDF00" />
      <circle cx="12" cy="8.5" r="3.4" fill="#002776" />
      <path d="M8.9 7.6c2.1-.5 4.4-.2 6.3 1" stroke="#fff" strokeWidth=".6" fill="none" />
    </svg>
  );
}

export default function InteresseGeralPage() {
  const query = new URLSearchParams(window.location.search);
  const isEmbed = query.get("embed") === "1";
  const grupoParam = query.get("grupo");
  const corParam = parseCor(query.get("cor"));

  const [group, setGroup] = useState<GroupInfo | null>(null);
  // Texto da caixa de consentimento, como o servidor o registra. A caixa nasce desmarcada.
  const [consentimentoTexto, setConsentimentoTexto] = useState<string | null>(null);
  const [consentiu, setConsentiu] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [values, setValues] = useState<Record<FieldKey, string>>({ nome: "", celular: "", instagram: "", email: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // O iframe precisa deixar o fundo da página do Wix aparecer.
  useEffect(() => {
    if (!isEmbed) return;
    const previous = [document.documentElement.style.background, document.body.style.background];
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      document.documentElement.style.background = previous[0]!;
      document.body.style.background = previous[1]!;
    };
  }, [isEmbed]);

  useEffect(() => {
    let cancelled = false;
    const suffix = grupoParam ? `?grupo=${encodeURIComponent(grupoParam)}` : "";
    fetch(`/api/public/interesse/formulario${suffix}`)
      .then(async response => {
        if (!response.ok) throw new Error("load");
        return (await response.json()) as FormDefinition;
      })
      .then(data => { if (!cancelled) { setGroup(data.grupo); setConsentimentoTexto(data.consentimento?.texto ?? null); setLoaded(true); } })
      .catch(() => { if (!cancelled) { setLoadFailed(true); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [grupoParam]);

  const accent = corParam ?? group?.cor ?? DEFAULT_ACCENT;
  const accentText = corParam ? readableTextOn(corParam) : group?.corTexto ?? DEFAULT_ACCENT_TEXT;
  const style = { "--ig-accent": accent, "--ig-accent-text": accentText } as CSSProperties;

  const update = (key: FieldKey) => (event: { target: { value: string } }) => {
    setValues(current => ({ ...current, [key]: event.target.value }));
  };

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/public/interesse/submissoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          respostas: values,
          // Só marcado de verdade conta como consentimento.
          consentimentoWhatsapp: consentimentoTexto !== null && consentiu,
          grupo: grupoParam ?? undefined,
          eventoId: query.get("eventoId") || undefined,
          // Quando o Wix informa a página, ela vem do navegador; o grupo continua sendo o dado confiável.
          paginaOrigem: document.referrer || undefined,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : "Não foi possível enviar. Tente novamente.");
        return;
      }
      setSuccess(true);
    } catch {
      setError("Não foi possível enviar. Verifique sua conexão e tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  const wrapperClass = `ig-page ${isEmbed ? "ig-page--embed" : "ig-page--standalone"}`;

  return (
    <div className={wrapperClass} style={style} data-testid="interesse-geral">
      <div className="ig-card">
        {!isEmbed && <h2 className="ig-title">Preencha o formulário de inscrição</h2>}
        {!isEmbed && group && <p className="ig-caption" data-testid="text-grupo">Grupo: {group.label}</p>}
        {!loaded ? null : loadFailed ? (
          <p className="ig-error" role="alert" data-testid="text-load-error">
            Não foi possível carregar o formulário. Recarregue a página.
          </p>
        ) : success ? (
          <div className="ig-success" role="status" data-testid="status-success">
            <span className="ig-success-icon"><Check size={26} aria-hidden="true" /></span>
            <p className="ig-success-title">Interesse registrado!</p>
            <p className="ig-success-text">Obrigado! Em breve entraremos em contato.</p>
          </div>
        ) : (
          <form className="ig-form" onSubmit={handleSubmit} data-testid="form-interesse">
            <div className="ig-field">
              <label className="ig-label" htmlFor="ig-nome">Nome *</label>
              <div className="ig-control">
                <input id="ig-nome" className="ig-input" type="text" name="nome" autoComplete="name" required maxLength={200}
                  value={values.nome} onChange={update("nome")} data-testid="input-nome" />
              </div>
            </div>
            <div className="ig-row">
              <div className="ig-field">
                <label className="ig-label" htmlFor="ig-celular">WhatsApp *</label>
                <div className="ig-control">
                  <BrazilFlag />
                  <input id="ig-celular" className="ig-input" type="tel" name="celular" autoComplete="tel-national" inputMode="tel"
                    placeholder="(11) 99999-9999" required maxLength={40}
                    value={values.celular} onChange={update("celular")} data-testid="input-celular" />
                </div>
              </div>
              <div className="ig-field">
                <label className="ig-label" htmlFor="ig-instagram">Instagram</label>
                <div className="ig-control">
                  <input id="ig-instagram" className="ig-input" type="text" name="instagram" autoComplete="off" autoCapitalize="none"
                    placeholder="@usuario" maxLength={100}
                    value={values.instagram} onChange={update("instagram")} data-testid="input-instagram" />
                </div>
              </div>
            </div>
            <div className="ig-field">
              <label className="ig-label" htmlFor="ig-email">Email *</label>
              <div className="ig-control">
                <input id="ig-email" className="ig-input" type="email" name="email" autoComplete="email" required maxLength={254}
                  value={values.email} onChange={update("email")} data-testid="input-email" />
              </div>
            </div>
            {consentimentoTexto && (
              <label className="ig-consent" htmlFor="ig-consentimento">
                <input id="ig-consentimento" className="ig-consent-box" type="checkbox" name="consentimentoWhatsapp"
                  checked={consentiu} onChange={event => setConsentiu(event.target.checked)} data-testid="input-consentimento" />
                <span>{consentimentoTexto}</span>
              </label>
            )}
            {error && <p className="ig-error" role="alert" data-testid="text-error">{error}</p>}
            <button type="submit" className="ig-button" disabled={submitting} data-testid="button-enviar">
              {submitting ? "Enviando..." : "Enviar"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
