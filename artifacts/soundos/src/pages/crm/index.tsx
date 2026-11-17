import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useLang } from "@/contexts/language";
import { CrmBoard } from "./components/crm-board";
import { CrmList } from "./components/crm-list";
import { CardModal } from "./components/card-modal";
import { useStageTransitions } from "./use-stage-transitions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, FilterX, LayoutList, Columns3 } from "lucide-react";
import { CreateOpportunityDialog } from "./components/create-dialog";
import { OpportunityNucleus, useGetCommercialFilterOptions, type ListCommercialOpportunitiesParams } from "@workspace/api-client-react";

type View = "quadro" | "lista";
const VIEW_STORAGE_KEY = "soundos.crm.view";

function readView(): View {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "lista" ? "lista" : "quadro";
  } catch {
    return "quadro";
  }
}

export default function CrmPage() {
  const { t } = useLang();

  const [view, setView] = useState<View>(readView);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Atalho de outras telas (ex.: "arquivo novo" em Conversas): /crm?card=ID abre o cartão direto.
  const search0 = useSearch();
  const [, navigate] = useLocation();
  const cartaoDaUrl = (() => {
    const valor = new URLSearchParams(search0).get("card");
    const id = valor ? Number(valor) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  })();
  useEffect(() => { if (cartaoDaUrl !== null) setSelectedId(cartaoDaUrl); }, [cartaoDaUrl]);
  const fecharCartao = () => {
    setSelectedId(null);
    if (cartaoDaUrl !== null) navigate("/crm", { replace: true });
  };
  const [grupo, setGrupo] = useState("ALL");
  const [cursoId, setCursoId] = useState("ALL");
  const [eventoId, setEventoId] = useState("ALL");
  const { data: filterOptions } = useGetCommercialFilterOptions();

  const [search, setSearch] = useState("");
  const [nucleus, setNucleus] = useState<OpportunityNucleus | "ALL">("ALL");
  const [ownerFilter, setOwnerFilter] = useState<"ALL" | "UNASSIGNED">("ALL");
  const [includeClosed, setIncludeClosed] = useState(false);
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const filters = useMemo<ListCommercialOpportunitiesParams>(() => ({
    search: search || undefined,
    nucleus: nucleus === "ALL" ? undefined : nucleus,
    unassigned: ownerFilter === "UNASSIGNED" ? true : undefined,
    includeClosed,
    grupo: grupo === "ALL" ? undefined : grupo,
    cursoId: cursoId === "ALL" ? undefined : Number(cursoId),
    eventoId: eventoId === "ALL" ? undefined : Number(eventoId),
  }), [search, nucleus, ownerFilter, includeClosed, grupo, cursoId, eventoId]);
  const transitions = useStageTransitions(filters);

  // Com um curso escolhido, a lista de eventos mostra só os dele.
  const eventosVisiveis = (filterOptions?.eventos ?? []).filter(e => cursoId === "ALL" || e.cursoId === Number(cursoId));
  const hasFilters = search || nucleus !== "ALL" || ownerFilter !== "ALL" || includeClosed || grupo !== "ALL" || cursoId !== "ALL" || eventoId !== "ALL";

  const changeView = (next: View) => {
    setView(next);
    try { localStorage.setItem(VIEW_STORAGE_KEY, next); } catch { /* preferência só deste navegador */ }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)] overflow-hidden">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground mb-1">{t("crm.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("crm.subtitle")}</p>
        </div>
        
        <div className="flex items-center gap-2 shrink-0">
          <div className="inline-flex rounded-md border bg-card p-0.5" role="group" aria-label={t("crm.visao.titulo")}>
            <Button size="sm" variant={view === "quadro" ? "secondary" : "ghost"} className="h-8 px-2.5 text-xs" aria-pressed={view === "quadro"}
              onClick={() => changeView("quadro")} data-testid="crm-visao-quadro">
              <Columns3 className="h-4 w-4 mr-1.5" />{t("crm.visao.quadro")}
            </Button>
            <Button size="sm" variant={view === "lista" ? "secondary" : "ghost"} className="h-8 px-2.5 text-xs" aria-pressed={view === "lista"}
              onClick={() => changeView("lista")} data-testid="crm-visao-lista">
              <LayoutList className="h-4 w-4 mr-1.5" />{t("crm.visao.lista")}
            </Button>
          </div>
          <Button onClick={() => setIsCreateOpen(true)} className="font-medium tracking-wide text-xs uppercase" size="sm">
            <Plus className="h-4 w-4 mr-2" />
            {t("crm.nova_oportunidade")}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3 shrink-0 p-2 bg-card border border-border rounded-lg shadow-sm">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder={t("common.buscar")} 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm bg-background"
          />
        </div>
        
        <Select value={nucleus} onValueChange={(v: any) => setNucleus(v)}>
          <SelectTrigger className="w-[160px] h-9 text-sm bg-background">
            <SelectValue placeholder={t("crm.form.nucleus" as any)} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("crm.filter.all_nucleus" as any)}</SelectItem>
            <SelectItem value="EDUCATION">{t("crm.nucleus.EDUCATION" as any)}</SelectItem>
            <SelectItem value="EXPERIENCES">{t("crm.nucleus.EXPERIENCES" as any)}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={ownerFilter} onValueChange={(v: "ALL" | "UNASSIGNED") => setOwnerFilter(v)}>
          <SelectTrigger className="w-[190px] h-9 text-sm bg-background" data-testid="crm-filter-owner">
            <SelectValue placeholder={t("crm.form.owner")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("crm.filter.all_owners" as any)}</SelectItem>
            <SelectItem value="UNASSIGNED">{t("crm.filter.unassigned" as any)}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={grupo} onValueChange={setGrupo}>
          <SelectTrigger className="w-[170px] h-9 text-sm bg-background" data-testid="crm-filter-grupo">
            <SelectValue placeholder={t("crm.filtro.grupo")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("crm.filtro.todos_grupos")}</SelectItem>
            {(filterOptions?.grupos ?? []).map(g => (
              <SelectItem key={g.value} value={g.value}>{g.label ?? g.value}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={cursoId} onValueChange={v => { setCursoId(v); setEventoId("ALL"); }}>
          <SelectTrigger className="w-[190px] h-9 text-sm bg-background" data-testid="crm-filter-curso">
            <SelectValue placeholder={t("crm.filtro.curso")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("crm.filtro.todos_cursos")}</SelectItem>
            {(filterOptions?.cursos ?? []).map(c => (
              <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={eventoId} onValueChange={setEventoId}>
          <SelectTrigger className="w-[190px] h-9 text-sm bg-background" data-testid="crm-filter-evento">
            <SelectValue placeholder={t("crm.filtro.evento")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("crm.filtro.todos_eventos")}</SelectItem>
            {eventosVisiveis.map(e => (
              <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={includeClosed ? "CLOSED" : "ACTIVE"} onValueChange={(v) => setIncludeClosed(v === "CLOSED")}>
          <SelectTrigger className="w-[160px] h-9 text-sm bg-background">
            <SelectValue placeholder={t("crm.filter.status" as any)} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ACTIVE">{t("crm.filter.active" as any)}</SelectItem>
            <SelectItem value="CLOSED">{t("crm.filter.include_closed" as any)}</SelectItem>
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-9 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setSearch("");
              setNucleus("ALL");
              setOwnerFilter("ALL");
              setIncludeClosed(false);
              setGrupo("ALL");
              setCursoId("ALL");
              setEventoId("ALL");
            }}
          >
            <FilterX className="h-4 w-4 mr-1" />
            {t("crm.filter.clear" as any)}
          </Button>
        )}
      </div>

      {/* Board / list area */}
      <div className="flex-1 min-h-0 relative -mx-4 sm:mx-0">
        {view === "quadro" ? (
          <CrmBoard filters={filters} onOpenCard={setSelectedId} onMoveToStage={transitions.requestTransition} />
        ) : (
          <CrmList filters={filters} onOpen={setSelectedId} />
        )}
      </div>

      <CardModal
        opportunityId={selectedId}
        onClose={fecharCartao}
        onChangeStage={transitions.requestTransition}
      />
      {transitions.dialog}

      <CreateOpportunityDialog 
        open={isCreateOpen} 
        onOpenChange={setIsCreateOpen} 
      />
    </div>
  );
}