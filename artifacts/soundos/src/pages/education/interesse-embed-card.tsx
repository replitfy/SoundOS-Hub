import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Code2, Copy, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import {
  INTERESSE_IFRAME_HEIGHT,
  buildInteresseIframe,
  buildInteresseUrl,
  normalizeGrupo,
  parseCor,
} from "@/lib/interesse-embed";

interface InterestGroup { slug: string; label: string; cor: string }
interface FormDefinition { grupos: InterestGroup[] }
interface EventOptionsResponse { rows: Array<{ eventId: number; eventName: string }> }

const NO_GROUP = "__none__";
const OTHER_GROUP = "__other__";
const NO_EVENT = "__none__";

function appOrigin(): { origin: string; base: string } {
  return { origin: window.location.origin, base: import.meta.env.BASE_URL };
}

/** Gerador do link e do código de iframe do formulário de interesse genérico usado no site. */
export function InteresseEmbedCard() {
  const { lang } = useLang();
  const fr = lang === "fr";
  const { authHeader } = useUserSession();
  const [choice, setChoice] = useState<string>(NO_GROUP);
  const [customGroup, setCustomGroup] = useState("");
  const [customColor, setCustomColor] = useState("");
  const [eventoId, setEventoId] = useState("");

  const { data } = useQuery<FormDefinition>({
    queryKey: ["/api/public/interesse/formulario"],
    queryFn: async () => {
      const response = await fetch("/api/public/interesse/formulario");
      if (!response.ok) throw new Error("Erro ao carregar os grupos");
      return response.json();
    },
  });
  const groups = data?.grupos ?? [];
  const eventsQuery = useQuery<EventOptionsResponse>({
    queryKey: ["interest-form-event-options", "active"],
    queryFn: async () => {
      const response = await fetch("/api/education/event-summary?status=active", { headers: authHeader });
      if (!response.ok) throw new Error("Erro ao carregar cursos e eventos");
      return response.json();
    },
  });
  const events = eventsQuery.data?.rows ?? [];

  const grupo = choice === NO_GROUP ? "" : choice === OTHER_GROUP ? normalizeGrupo(customGroup) : choice;
  const cor = parseCor(customColor);
  const invalidColor = customColor.trim() !== "" && cor === null;
  const { origin, base } = appOrigin();
  const link = buildInteresseUrl({ origin, base, grupo, cor, eventoId });
  const embedUrl = buildInteresseUrl({ origin, base, grupo, cor, eventoId, embed: true });
  const iframeCode = buildInteresseIframe(embedUrl);

  const copy = (text: string, message: string) => {
    navigator.clipboard.writeText(text)
      .then(() => toast.success(message))
      .catch(() => toast.error(fr ? "Impossible de copier" : "Não foi possível copiar"));
  };

  return (
    <Card data-testid="interesse-embed-card">
      <CardContent className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">{fr ? "Groupe" : "Grupo"}</Label>
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger className="h-8 text-sm" data-testid="interesse-embed-grupo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>{fr ? "Sans groupe (intérêt général)" : "Sem grupo (interesse geral)"}</SelectItem>
                {groups.map(group => (
                  <SelectItem key={group.slug} value={group.slug}>{group.label}</SelectItem>
                ))}
                <SelectItem value={OTHER_GROUP}>{fr ? "Autre groupe…" : "Outro grupo…"}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">
              {fr ? "Cours ou événement (facultatif)" : "Curso ou evento (opcional)"}
            </Label>
            <Select value={eventoId || NO_EVENT} onValueChange={value => setEventoId(value === NO_EVENT ? "" : value)}>
              <SelectTrigger className="h-8 text-sm" data-testid="interesse-embed-evento">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_EVENT}>{fr ? "Sans lien avec un cours ou événement" : "Sem vínculo com curso ou evento"}</SelectItem>
                {events.map(event => (
                  <SelectItem key={event.eventId} value={String(event.eventId)}>{event.eventName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {eventsQuery.isError && (
              <p className="text-[11px] text-destructive" role="alert">
                {fr ? "Impossible de charger les cours et événements." : "Não foi possível carregar cursos e eventos."}
              </p>
            )}
          </div>

          {choice === OTHER_GROUP && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">{fr ? "Nom du groupe" : "Nome do grupo"}</Label>
              <Input
                value={customGroup}
                onChange={event => setCustomGroup(event.target.value)}
                placeholder="Ex: eter"
                className="h-8 text-sm"
                data-testid="interesse-embed-outro-grupo"
              />
              <p className="text-[11px] text-muted-foreground">
                {grupo
                  ? `${fr ? "Sera enregistré comme" : "Será registrado como"}: ${grupo}`
                  : (fr ? "Lettres, chiffres et tiret." : "Letras, números e hífen.")}
              </p>
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">
              {fr ? "Couleur (optionnel)" : "Cor (opcional)"}
            </Label>
            <Input
              value={customColor}
              onChange={event => setCustomColor(event.target.value)}
              placeholder="2BA8E0"
              className="h-8 text-sm"
              aria-invalid={invalidColor}
              data-testid="interesse-embed-cor"
            />
            {invalidColor && (
              <p className="text-[11px] text-destructive">
                {fr ? "Utilisez 6 caractères hexadécimaux, ex. 2BA8E0." : "Use 6 caracteres hexadecimais, ex.: 2BA8E0."}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input readOnly value={link} className="h-8 flex-1 text-xs font-mono" aria-label={fr ? "Lien" : "Link"} data-testid="interesse-embed-link" />
            <Button size="sm" variant="secondary" className="h-8 text-xs" onClick={() => copy(link, fr ? "Lien copié" : "Link copiado")}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" /> {fr ? "Copier le lien" : "Copiar link"}
            </Button>
          </div>
          <div className="flex items-start gap-2">
            <textarea
              readOnly
              value={iframeCode}
              rows={3}
              aria-label="iframe"
              className="min-h-[64px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
              data-testid="interesse-embed-iframe"
            />
            <Button size="sm" className="h-8 text-xs" onClick={() => copy(iframeCode, fr ? "Code iframe copié" : "Código iframe copiado")}>
              <Code2 className="mr-1.5 h-3.5 w-3.5" /> {fr ? "Copier le code" : "Copiar código"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {fr
              ? `Hauteur recommandée de l'iframe : ${INTERESSE_IFRAME_HEIGHT}px. Le groupe et le cours ou l'événement choisi sont liés au formulaire ; l'adresse de la page peut arriver incomplète (Wix n'envoie parfois que le domaine) et reste une information complémentaire.`
              : `Altura recomendada do iframe: ${INTERESSE_IFRAME_HEIGHT}px. O grupo e o curso ou evento escolhido ficam vinculados ao formulário; o endereço da página pode chegar incompleto (o Wix às vezes envia só o domínio) e fica como informação adicional.`}
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">{fr ? "Aperçu" : "Prévia"}</Label>
            <Button size="sm" variant="ghost" className="h-7 text-xs" asChild>
              <a href={link} target="_blank" rel="noreferrer">
                <Copy className="mr-1.5 h-3.5 w-3.5" /> {fr ? "Ouvrir" : "Abrir"}
              </a>
            </Button>
          </div>
          <div className="rounded-md border border-border bg-[#1f1f1f] p-3">
            <iframe
              key={embedUrl}
              src={embedUrl}
              title={fr ? "Aperçu du formulaire" : "Prévia do formulário"}
              width="100%"
              height={INTERESSE_IFRAME_HEIGHT}
              style={{ border: "none" }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
