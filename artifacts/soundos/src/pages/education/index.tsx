import { useState, useMemo, useEffect, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  Info,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Users,
  Banknote,
  Calendar,
  LayoutList,
  CheckCircle,
  PiggyBank,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
} from "lucide-react";
import { format, parseISO } from "date-fns";

import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  EDUCATION_PAGE_SIZE,
  type EducationSort,
  type EducationSortKey,
  clampPage,
  isPastEducationEvent,
  paginateEducationRows,
  parseEducationSort,
  sortEducationRows,
} from "./education-table-state";

export interface EventSummaryRow {
  eventId: number;
  eventName: string;
  eventType: string;
  active: boolean;
  startDate: string | null;
  endDate: string | null;
  city: string | null;
  location: string | null;
  classId: number | null;
  classCode: string | null;
  courseId: number | null;
  courseName: string | null;
  capacity: number | null;
  enrolled: number;
  available: number | null;
  contracted: number;
  paid: number;
  outstanding: number;
  paidPercent: number | null;
}

export interface EventSummaryFilters {
  years: number[];
  eventTypes: string[];
  courses: string[];
  cities: string[];
}

export interface EventSummaryTotals {
  events: number;
  enrolled: number;
  available: number | null;
  capacity: number | null;
  contracted: number;
  paid: number;
  outstanding: number;
  paidPercent: number | null;
}

export interface EventSummaryResponse {
  rows: EventSummaryRow[];
  totals: EventSummaryTotals;
  filters: EventSummaryFilters;
}

type EducationColumnKey = EducationSortKey;
type EducationColumnWidths = Record<EducationColumnKey, number>;

const EDUCATION_COLUMN_WIDTHS: EducationColumnWidths = {
  event: 220,
  code: 92,
  year: 58,
  month: 54,
  startDate: 92,
  city: 112,
  enrolled: 90,
  available: 72,
  contracted: 132,
  paid: 132,
  outstanding: 132,
  paidPercent: 76,
};

const EDUCATION_COLUMN_MIN_WIDTHS: EducationColumnWidths = {
  event: 140,
  code: 64,
  year: 48,
  month: 48,
  startDate: 76,
  city: 72,
  enrolled: 72,
  available: 64,
  contracted: 88,
  paid: 88,
  outstanding: 88,
  paidPercent: 68,
};

const EDUCATION_COLUMN_KEYS = Object.keys(EDUCATION_COLUMN_WIDTHS) as EducationColumnKey[];
const EDUCATION_COLUMN_STORAGE_KEY = "soundos_education_column_widths";

function loadEducationColumnWidths(): EducationColumnWidths {
  try {
    const saved = JSON.parse(localStorage.getItem(EDUCATION_COLUMN_STORAGE_KEY) ?? "{}");
    return Object.fromEntries(EDUCATION_COLUMN_KEYS.map(key => [
      key,
      Math.max(EDUCATION_COLUMN_MIN_WIDTHS[key], Number(saved[key]) || EDUCATION_COLUMN_WIDTHS[key]),
    ])) as EducationColumnWidths;
  } catch {
    return EDUCATION_COLUMN_WIDTHS;
  }
}

function useEventSummary() {
  const { authHeader } = useUserSession();

  return useQuery<EventSummaryResponse>({
    queryKey: ["event-summary", "active"],
    queryFn: async () => {
      const res = await fetch("/api/education/event-summary?status=active", { headers: authHeader });
      if (!res.ok) {
        throw new Error("Failed to fetch event summary");
      }
      return res.json();
    },
  });
}

function formatCurrency(val: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(val);
}

function formatDate(isoDate: string | null): string {
  if (!isoDate) return "-";
  try {
    const d = parseISO(isoDate);
    return format(d, "dd/MM/yyyy");
  } catch {
    return isoDate;
  }
}

function extractMonth(isoDate: string | null): string {
  if (!isoDate) return "-";
  try {
    const d = parseISO(isoDate);
    return format(d, "MM"); // 01-12
  } catch {
    return "-";
  }
}

function extractYear(isoDate: string | null): string {
  if (!isoDate) return "-";
  try {
    const d = parseISO(isoDate);
    return format(d, "yyyy");
  } catch {
    return "-";
  }
}

function saoPauloToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export default function EducationPanel() {
  const { t, lang } = useLang();
  const { data, isLoading, isError, refetch } = useEventSummary();
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);

  // URL State Synced
  const [search, setSearch] = useState(() => initialParams.get("q") ?? "");
  const [year, setYear] = useState<string>(() => initialParams.get("year") ?? "all");
  const [type, setType] = useState<string>(() => initialParams.get("type") ?? "all");
  const [course, setCourse] = useState<string>(() => initialParams.get("course") ?? "all");
  const [city, setCity] = useState<string>(() => initialParams.get("city") ?? "all");
  const [month, setMonth] = useState<string>(() => initialParams.get("month") ?? "all");
  const [hidePastEvents, setHidePastEvents] = useState(() => initialParams.get("showPast") !== "true");
  const [sorting, setSorting] = useState<EducationSort>(() =>
    parseEducationSort(initialParams.get("sort"), initialParams.get("dir")));
  const [groupByCourse, setGroupByCourse] = useState(() => initialParams.get("group") === "true");
  const [page, setPage] = useState(1);
  const [columnWidths, setColumnWidths] = useState(loadEducationColumnWidths);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    localStorage.setItem(EDUCATION_COLUMN_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  const resizeColumn = useCallback((key: EducationColumnKey, width: number) => {
    setColumnWidths(current => ({
      ...current,
      [key]: Math.max(EDUCATION_COLUMN_MIN_WIDTHS[key], Math.min(600, Math.round(width))),
    }));
  }, []);

  const visibleColumnKeys = useMemo(() => EDUCATION_COLUMN_KEYS.filter(key => {
    if (["code", "outstanding"].includes(key)) return viewportWidth >= 768;
    if (["year", "month", "city"].includes(key)) return viewportWidth >= 1024;
    if (key === "contracted") return viewportWidth >= 1280;
    if (["available", "paidPercent"].includes(key)) return viewportWidth >= 640;
    return true;
  }), [viewportWidth]);
  const tableWidth = visibleColumnKeys.reduce((total, key) => total + columnWidths[key], 0);

  // Update URL
  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (year !== "all") params.set("year", year);
    if (type !== "all") params.set("type", type);
    if (course !== "all") params.set("course", course);
    if (city !== "all") params.set("city", city);
    if (month !== "all") params.set("month", month);
    if (!hidePastEvents) params.set("showPast", "true");
    if (sorting.key !== "startDate" || sorting.direction !== "asc") {
      params.set("sort", sorting.key);
      params.set("dir", sorting.direction);
    }
    if (groupByCourse) params.set("group", "true");

    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
    window.history.replaceState(null, "", newUrl);
  }, [search, year, type, course, city, month, sorting, groupByCourse, hidePastEvents]);

  // Derived filtered rows
  const filteredRows = useMemo(() => {
    if (!data?.rows) return [];
    const today = saoPauloToday();

    const rows = data.rows.filter(row => {
      if (hidePastEvents && isPastEducationEvent(row, today)) return false;

      // Search
      if (search) {
        const q = search.toLowerCase();
        if (!row.eventName?.toLowerCase().includes(q) &&
            !row.courseName?.toLowerCase().includes(q) &&
            !row.classCode?.toLowerCase().includes(q) &&
            !row.location?.toLowerCase().includes(q) &&
            !row.city?.toLowerCase().includes(q)) {
          return false;
        }
      }

      // Year
      if (year !== "all") {
        if (!row.startDate || !row.startDate.startsWith(year)) return false;
      }

      // Month
      if (month !== "all") {
        if (!row.startDate) return false;
        const rowMonth = parseInt(row.startDate.split("-")[1], 10).toString();
        if (rowMonth !== month) return false;
      }

      // Type
      if (type !== "all" && row.eventType !== type) return false;

      // Course
      if (course !== "all" && row.courseName !== course) return false;

      // City
      if (city !== "all" && row.city !== city) return false;

      return true;
    });
    return sortEducationRows(rows, sorting);
  }, [data, search, year, type, course, city, month, sorting, hidePastEvents]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / EDUCATION_PAGE_SIZE));
  const currentPage = clampPage(page, filteredRows.length);
  const pagedRows = useMemo(
    () => paginateEducationRows(filteredRows, currentPage),
    [filteredRows, currentPage],
  );

  useEffect(() => {
    setPage(1);
  }, [search, year, type, course, city, month, sorting, groupByCourse, hidePastEvents]);

  useEffect(() => {
    setPage(current => clampPage(current, filteredRows.length));
  }, [filteredRows.length]);

  // Grouped structure
  const groupedData = useMemo(() => {
    if (!groupByCourse) return null;

    const groups = new Map<string, { rows: EventSummaryRow[], totals: {
      enrolled: number;
      capacity: number;
      paid: number;
      contracted: number;
      available: number;
      outstanding: number;
      hasClasses: boolean;
    } }>();

    pagedRows.forEach(row => {
      const key = row.courseName || "Outros";
      if (!groups.has(key)) {
        groups.set(key, { rows: [], totals: { enrolled: 0, capacity: 0, paid: 0, contracted: 0, available: 0, outstanding: 0, hasClasses: false } });
      }
      const group = groups.get(key)!;
      group.rows.push(row);
      group.totals.enrolled += row.enrolled || 0;
      if (row.capacity !== null) {
        group.totals.capacity += row.capacity;
        group.totals.hasClasses = true;
      }
      if (row.available !== null) {
        group.totals.available += row.available;
      }
      group.totals.paid += row.paid || 0;
      group.totals.outstanding += row.outstanding || 0;
      group.totals.contracted += row.contracted || 0;
    });

    return Array.from(groups, ([name, group]) => ({
      name,
      rows: group.rows,
      totals: {
        ...group.totals,
        capacity: group.totals.hasClasses ? group.totals.capacity : null,
        available: group.totals.hasClasses ? group.totals.available : null,
        paidPercent: group.totals.contracted > 0 ? (group.totals.paid / group.totals.contracted) * 100 : null
      }
    }));
  }, [pagedRows, groupByCourse]);

  const toggleSort = (key: EducationSortKey) => {
    setSorting(current => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  // View totals calculated from filtered dataset
  const viewTotals = useMemo(() => {
    let tEnrolled = 0, tAvailable = 0, tContracted = 0, tPaid = 0, tOutstanding = 0, tCapacity = 0;
    let hasClasses = false;
    filteredRows.forEach(r => {
      tEnrolled += r.enrolled;
      if (r.capacity !== null) {
        tCapacity += r.capacity;
        hasClasses = true;
      }
      if (r.available !== null) {
        tAvailable += r.available;
      }
      tContracted += r.contracted;
      tPaid += r.paid;
      tOutstanding += r.outstanding;
    });
    return {
      events: filteredRows.length,
      enrolled: tEnrolled,
      available: hasClasses ? tAvailable : null,
      capacity: hasClasses ? tCapacity : null,
      contracted: tContracted,
      paid: tPaid,
      outstanding: tOutstanding,
      paidPercent: tContracted > 0 ? (tPaid / tContracted) * 100 : null
    };
  }, [filteredRows]);

  if (isError) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTitle>{t("common.erro")}</AlertTitle>
          <AlertDescription>{t("edu.summary.erro_carregar")}</AlertDescription>
        </Alert>
        <Button className="mt-4" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" /> {t("edu.summary.tentar_novamente")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-20 animate-in fade-in duration-300">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("edu.painel.title")}</h1>
          <p className="text-muted-foreground">{t("edu.painel.subtitle")}</p>
        </div>
      </div>

      {/* KPI Cards (Compact) */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <div className="bg-card rounded-md border p-3 shadow-sm flex flex-col justify-between">
          <div className="flex items-center text-muted-foreground mb-1 text-xs font-medium truncate">
            <Calendar className="w-3.5 h-3.5 mr-1 text-primary shrink-0" />
            {t("edu.summary.kpi_eventos")}
          </div>
          <div className="text-xl font-bold">{isLoading ? <Skeleton className="h-6 w-12" /> : viewTotals.events}</div>
        </div>

        <div className="bg-card rounded-md border p-3 shadow-sm flex flex-col justify-between">
          <div className="flex items-center text-muted-foreground mb-1 text-xs font-medium truncate">
            <CheckCircle className="w-3.5 h-3.5 mr-1 text-agua shrink-0" />
            {t("edu.summary.kpi_inscritos")}
          </div>
          <div className="text-xl font-bold">
            {isLoading ? <Skeleton className="h-6 w-16" /> : viewTotals.enrolled}
          </div>
        </div>

        <div className="bg-card rounded-md border p-3 shadow-sm flex flex-col justify-between">
          <div className="flex items-center text-muted-foreground mb-1 text-xs font-medium truncate">
            <Users className="w-3.5 h-3.5 mr-1 text-muted-foreground shrink-0" />
            {t("edu.summary.kpi_vagas")}
          </div>
          <div className="text-xl font-bold">
            {isLoading ? <Skeleton className="h-6 w-16" /> : (
              viewTotals.available === null ? "—" : viewTotals.available
            )}
          </div>
        </div>

        <div className="bg-card rounded-md border p-3 shadow-sm flex flex-col justify-between">
          <div className="flex items-center text-muted-foreground mb-1 text-xs font-medium truncate">
            <Banknote className="w-3.5 h-3.5 mr-1 text-fogo shrink-0" />
            {t("edu.summary.kpi_contratado")}
          </div>
          <div className="text-lg font-bold">
            {isLoading ? <Skeleton className="h-6 w-24" /> : formatCurrency(viewTotals.contracted)}
          </div>
        </div>

        <div className="bg-card rounded-md border p-3 shadow-sm flex flex-col justify-between">
          <div className="flex items-center text-muted-foreground mb-1 text-xs font-medium truncate">
            <PiggyBank className="w-3.5 h-3.5 mr-1 text-terra shrink-0" />
            {t("edu.summary.kpi_pago")}
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3 w-3 ml-1 text-muted-foreground cursor-help shrink-0" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs text-xs">{t("edu.summary.tooltip_paid")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="text-lg font-bold">
            {isLoading ? <Skeleton className="h-6 w-24" /> : formatCurrency(viewTotals.paid)}
          </div>
        </div>

        <div className="bg-card rounded-md border p-3 shadow-sm flex flex-col justify-between">
          <div className="flex items-center text-muted-foreground mb-1 text-xs font-medium truncate">
            <Banknote className="w-3.5 h-3.5 mr-1 text-muted-foreground shrink-0" />
            {t("edu.summary.kpi_pendente")}
          </div>
          <div className="text-lg font-bold">
            {isLoading ? <Skeleton className="h-6 w-24" /> : formatCurrency(viewTotals.outstanding)}
          </div>
        </div>

        <div className="bg-card rounded-md border p-3 shadow-sm flex flex-col justify-between">
          <div className="flex items-center text-muted-foreground mb-1 text-xs font-medium truncate">
            <LayoutList className="w-3.5 h-3.5 mr-1 text-primary shrink-0" />
            {t("edu.summary.kpi_pct")}
          </div>
          <div className="text-xl font-bold">
            {isLoading ? <Skeleton className="h-6 w-12" /> : (
              viewTotals.paidPercent === null ? "—" : `${viewTotals.paidPercent.toFixed(1)}%`
            )}
          </div>
        </div>
      </div>

      <div className="bg-card rounded-lg border shadow-sm flex flex-col">
        <div className="p-4 border-b bg-muted/20 flex flex-col lg:flex-row gap-4 flex-wrap">
          <div className="relative flex-1 min-w-[240px] flex flex-col gap-1">
            <Label htmlFor="education-summary-search" className="px-1 text-[11px] font-medium text-muted-foreground">
              {t("edu.summary.filtro_busca")}
            </Label>
            <Search className="absolute left-3 top-[36px] -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="education-summary-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("edu.summary.busca")}
              className="pl-9 w-full bg-background"
            />
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex items-center space-x-2 bg-background border rounded-md px-3 h-10">
              <Label htmlFor="hide-past-events" className="text-sm cursor-pointer whitespace-nowrap">
                {t("edu.summary.ocultar_passados")}
              </Label>
              <Switch
                id="hide-past-events"
                checked={hidePastEvents}
                onCheckedChange={setHidePastEvents}
                data-testid="education-hide-past-events"
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="education-filter-year" className="px-1 text-[11px] font-medium text-muted-foreground">
                {t("edu.summary.filtro_ano")}
              </Label>
              <Select value={year} onValueChange={setYear}>
                <SelectTrigger id="education-filter-year" className="w-[110px] bg-background">
                  <SelectValue placeholder={t("edu.summary.filtro_ano")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("edu.summary.todos")}</SelectItem>
                  {data?.filters.years.map(y => (
                    <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="education-filter-month" className="px-1 text-[11px] font-medium text-muted-foreground">
                {t("edu.summary.filtro_mes")}
              </Label>
              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger id="education-filter-month" className="w-[120px] bg-background">
                  <SelectValue placeholder={t("edu.summary.filtro_mes")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("edu.summary.todos")}</SelectItem>
                  {Array.from({ length: 12 }).map((_, i) => (
                    <SelectItem key={i+1} value={(i+1).toString()}>
                      {t(`edu.summary.meses.${i+1}` as any)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="education-filter-type" className="px-1 text-[11px] font-medium text-muted-foreground">
                {t("edu.summary.filtro_tipo")}
              </Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="education-filter-type" className="w-[130px] bg-background">
                  <SelectValue placeholder={t("edu.summary.filtro_tipo")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("edu.summary.todos")}</SelectItem>
                  {data?.filters.eventTypes.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="education-filter-course" className="px-1 text-[11px] font-medium text-muted-foreground">
                {t("edu.summary.filtro_curso")}
              </Label>
              <Select value={course} onValueChange={setCourse}>
                <SelectTrigger id="education-filter-course" className="w-[160px] bg-background">
                  <SelectValue placeholder={t("edu.summary.filtro_curso")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("edu.summary.todos")}</SelectItem>
                  {data?.filters.courses.map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="education-filter-city" className="px-1 text-[11px] font-medium text-muted-foreground">
                {t("edu.summary.filtro_cidade")}
              </Label>
              <Select value={city} onValueChange={setCity}>
                <SelectTrigger id="education-filter-city" className="w-[130px] bg-background">
                  <SelectValue placeholder={t("edu.summary.filtro_cidade")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("edu.summary.todos")}</SelectItem>
                  {data?.filters.cities.map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center space-x-2 bg-background border rounded-md px-3 h-10 ml-auto">
              <LayoutList className="h-4 w-4 text-muted-foreground" />
              <Label htmlFor="group-course" className="text-sm cursor-pointer">{t("edu.summary.agrupar_curso")}</Label>
              <Switch id="group-course" checked={groupByCourse} onCheckedChange={setGroupByCourse} />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto relative flex-1">
          <table
            className="table-fixed text-sm text-left"
            style={{ width: tableWidth }}
            data-testid="education-summary-table"
          >
            <colgroup>
              {EDUCATION_COLUMN_KEYS.map(key => (
                <col
                  key={key}
                  style={{ width: columnWidths[key] }}
                  className={
                    ["code", "outstanding"].includes(key) ? "hidden md:table-column"
                      : ["year", "month", "city"].includes(key) ? "hidden lg:table-column"
                        : key === "contracted" ? "hidden xl:table-column"
                          : ["available", "paidPercent"].includes(key) ? "hidden sm:table-column"
                            : undefined
                  }
                />
              ))}
            </colgroup>
            <thead className="text-xs text-muted-foreground bg-muted/40 uppercase sticky top-0 z-20">
              <tr>
                <SortableHeader sortKey="event" label={t("edu.summary.col_evento")} sorting={sorting} onSort={toggleSort} width={columnWidths.event} onResize={resizeColumn} lang={lang} className="sticky left-0 bg-muted/95 z-30 shadow-[1px_0_0_0_hsl(var(--border))]" />
                <SortableHeader sortKey="code" label={t("edu.summary.col_codigo")} sorting={sorting} onSort={toggleSort} width={columnWidths.code} onResize={resizeColumn} lang={lang} className="hidden md:table-cell" />
                <SortableHeader sortKey="year" label={t("edu.summary.col_ano")} sorting={sorting} onSort={toggleSort} width={columnWidths.year} onResize={resizeColumn} lang={lang} className="hidden lg:table-cell" />
                <SortableHeader sortKey="month" label={t("edu.summary.col_mes")} sorting={sorting} onSort={toggleSort} width={columnWidths.month} onResize={resizeColumn} lang={lang} className="hidden lg:table-cell" />
                <SortableHeader sortKey="startDate" label={t("edu.summary.col_dt_ini")} sorting={sorting} onSort={toggleSort} width={columnWidths.startDate} onResize={resizeColumn} lang={lang} className="whitespace-nowrap" />
                <SortableHeader sortKey="city" label={t("edu.summary.col_cidade")} sorting={sorting} onSort={toggleSort} width={columnWidths.city} onResize={resizeColumn} lang={lang} className="hidden lg:table-cell" />
                <SortableHeader sortKey="enrolled" label={t("edu.summary.col_ocupacao")} sorting={sorting} onSort={toggleSort} width={columnWidths.enrolled} onResize={resizeColumn} lang={lang} align="right" />
                <SortableHeader sortKey="available" label={t("edu.summary.col_vagas")} sorting={sorting} onSort={toggleSort} width={columnWidths.available} onResize={resizeColumn} lang={lang} align="right" className="hidden sm:table-cell" />
                <SortableHeader sortKey="contracted" label={t("edu.summary.col_contratado")} sorting={sorting} onSort={toggleSort} width={columnWidths.contracted} onResize={resizeColumn} lang={lang} align="right" className="hidden xl:table-cell" />
                <SortableHeader sortKey="paid" label={t("edu.summary.col_financeiro")} sorting={sorting} onSort={toggleSort} width={columnWidths.paid} onResize={resizeColumn} lang={lang} align="right" />
                <SortableHeader sortKey="outstanding" label={t("edu.summary.col_pendente")} sorting={sorting} onSort={toggleSort} width={columnWidths.outstanding} onResize={resizeColumn} lang={lang} align="right" className="hidden md:table-cell" />
                <SortableHeader sortKey="paidPercent" label={t("edu.summary.col_pct_pago")} sorting={sorting} onSort={toggleSort} width={columnWidths.paidPercent} onResize={resizeColumn} lang={lang} align="right" className="hidden sm:table-cell" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading ? (
                Array.from({ length: EDUCATION_PAGE_SIZE }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-1.5 py-4 sticky left-0 bg-card z-10 shadow-[1px_0_0_0_hsl(var(--border))]"><Skeleton className="h-4 w-3/4" /></td>
                    <td className="px-1.5 py-4 hidden md:table-cell"><Skeleton className="h-4 w-16" /></td>
                    <td className="px-1.5 py-4 hidden lg:table-cell"><Skeleton className="h-4 w-8" /></td>
                    <td className="px-1.5 py-4 hidden lg:table-cell"><Skeleton className="h-4 w-8" /></td>
                    <td className="px-1.5 py-4"><Skeleton className="h-4 w-20" /></td>
                    <td className="px-1.5 py-4 hidden lg:table-cell"><Skeleton className="h-4 w-20" /></td>
                    <td className="px-1.5 py-4"><Skeleton className="h-4 w-10 ml-auto" /></td>
                    <td className="px-1.5 py-4 hidden sm:table-cell"><Skeleton className="h-4 w-10 ml-auto" /></td>
                    <td className="px-1.5 py-4 hidden xl:table-cell"><Skeleton className="h-4 w-16 ml-auto" /></td>
                    <td className="px-1.5 py-4"><Skeleton className="h-4 w-20 ml-auto" /></td>
                    <td className="px-1.5 py-4 hidden md:table-cell"><Skeleton className="h-4 w-20 ml-auto" /></td>
                    <td className="px-1.5 py-4 hidden sm:table-cell"><Skeleton className="h-4 w-12 ml-auto" /></td>
                  </tr>
                ))
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-1.5 py-12 text-center text-muted-foreground">
                    {t("edu.summary.sem_resultados")}
                  </td>
                </tr>
              ) : groupByCourse ? (
                groupedData!.map(group => (
                  <GroupedRows key={group.name} group={group} t={t} lang={lang} />
                ))
              ) : (
                pagedRows.map(row => (
                  <RowItem key={row.eventId} row={row} t={t} lang={lang} />
                ))
              )}
            </tbody>
          </table>
        </div>
        {!isLoading && filteredRows.length > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
            <span data-testid="education-page-range">
              {(currentPage - 1) * EDUCATION_PAGE_SIZE + 1}–{Math.min(currentPage * EDUCATION_PAGE_SIZE, filteredRows.length)} {lang === "fr" ? "sur" : "de"} {filteredRows.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={currentPage === 1}
                onClick={() => setPage(Math.max(1, currentPage - 1))}
                data-testid="education-page-previous"
              >
                {lang === "fr" ? "Précédente" : "Anterior"}
              </Button>
              <span data-testid="education-page-number">
                {lang === "fr" ? "Page" : "Página"} {currentPage} {lang === "fr" ? "sur" : "de"} {pageCount}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={currentPage >= pageCount}
                onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
                data-testid="education-page-next"
              >
                {lang === "fr" ? "Suivante" : "Próxima"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SortableHeader({
  sortKey,
  label,
  sorting,
  onSort,
  width,
  onResize,
  lang,
  align = "left",
  className = "",
}: {
  sortKey: EducationSortKey;
  label: string;
  sorting: EducationSort;
  onSort: (key: EducationSortKey) => void;
  width: number;
  onResize: (key: EducationColumnKey, width: number) => void;
  lang: string;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sorting.key === sortKey;
  const ariaSort = active
    ? (sorting.direction === "asc" ? "ascending" : "descending")
    : "none";
  const Icon = active
    ? (sorting.direction === "asc" ? ArrowUp : ArrowDown)
    : ArrowUpDown;
  const startResize = (clientX: number) => {
    const initialWidth = width;
    const move = (event: PointerEvent) => onResize(sortKey, initialWidth + event.clientX - clientX);
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
  };

  return (
    <th
      className={`relative px-1.5 py-3 font-medium ${className}`}
      aria-sort={ariaSort}
      scope="col"
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex w-full items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${align === "right" ? "justify-end text-right" : "justify-start text-left"}`}
        data-testid={`education-sort-${sortKey}`}
      >
        <span className="truncate" title={label}>{label}</span>
        <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? "text-primary" : "opacity-50"}`} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="absolute inset-y-0 right-0 z-40 w-2 translate-x-1/2 cursor-col-resize touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary after:absolute after:inset-y-2 after:left-1/2 after:w-px after:bg-border hover:after:bg-primary"
        aria-label={`${lang === "fr" ? "Redimensionner la colonne" : "Redimensionar coluna"} ${label}`}
        data-testid={`education-resize-${sortKey}`}
        onPointerDown={event => {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          startResize(event.clientX);
        }}
        onDoubleClick={() => onResize(sortKey, EDUCATION_COLUMN_WIDTHS[sortKey])}
        onKeyDown={event => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            onResize(sortKey, width + (event.key === "ArrowRight" ? 10 : -10));
          }
        }}
      />
    </th>
  );
}

function RowItem({ row, t, lang, isSubRow = false }: { row: EventSummaryRow, t: any, lang: string, isSubRow?: boolean }) {
  const [, navigate] = useLocation();

  return (
    <tr
      className={`hover:bg-muted/30 transition-colors cursor-pointer focus-visible:outline-none focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${isSubRow ? 'bg-muted/10' : ''}`}
      onClick={() => navigate(`/education/cursos/${row.eventId}?view=readonly`)}
      tabIndex={0}
      role="link"
      data-event-id={row.eventId}
      aria-label={`${lang === "fr" ? "Voir les détails de l’événement" : "Ver detalhes do evento"} ${row.eventName}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(`/education/cursos/${row.eventId}?view=readonly`);
        }
      }}
    >
      {/* 1. Event / Course */}
      <td className={`px-1.5 py-3 sticky left-0 z-10 shadow-[1px_0_0_0_hsl(var(--border))] overflow-hidden ${isSubRow ? 'bg-muted/10' : 'bg-card'}`}>
        <div className={`flex flex-col ${isSubRow ? 'pl-6' : ''}`}>
          <div className="font-medium text-foreground flex items-center gap-2 truncate">
            <Link
              href={`/education/cursos/${row.eventId}?view=readonly`}
              className="truncate hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm text-[11px]"
              title={row.eventName}
              tabIndex={-1}
              data-testid={`education-event-link-${row.eventId}`}
            >
              {row.eventName}
            </Link>
            {!row.active && <Badge variant="secondary" className="text-[10px] py-0 h-4 px-1 shrink-0">{t("common.inativo")}</Badge>}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex gap-2 items-center truncate">
            {row.eventType && <span className="truncate">{row.eventType}</span>}
            {row.courseName && !isSubRow && (
              <>
                <span className="w-1 h-1 rounded-full bg-border shrink-0" />
                <span className="truncate" title={row.courseName}>{row.courseName}</span>
              </>
            )}
          </div>
        </div>
      </td>
      {/* 7. Class code (moved up for mobile priority handling but visually in its place based on thead) */}
      <td className="px-1.5 py-3 font-mono text-xs hidden md:table-cell truncate" title={row.classCode || ""}>
        {row.classCode || "-"}
      </td>
      {/* 8. Year */}
      <td className="px-1.5 py-3 hidden lg:table-cell">
        {extractYear(row.startDate)}
      </td>
      {/* 2. Month */}
      <td className="px-1.5 py-3 hidden lg:table-cell">
        {extractMonth(row.startDate)}
      </td>
      {/* 3. Start date */}
      <td className="px-1.5 py-3 whitespace-nowrap">
        {formatDate(row.startDate)}
      </td>
      {/* 5. City */}
      <td className="px-1.5 py-3 hidden lg:table-cell truncate" title={row.city || ""}>
        {row.city || "-"}
      </td>
      {/* 9. Enrolled */}
      <td className="px-1.5 py-3 text-right font-medium">
        {row.enrolled}
      </td>
      {/* 10. Available */}
      <td className="px-1.5 py-3 text-right hidden sm:table-cell text-muted-foreground">
        {row.available === null ? "—" : (
          <>{row.available} <span className="text-xs">/ {row.capacity}</span></>
        )}
      </td>
      {/* 11. Contracted */}
      <td className="px-1.5 py-3 text-right hidden xl:table-cell text-muted-foreground whitespace-nowrap">
        {formatCurrency(row.contracted)}
      </td>
      {/* 12. Paid */}
      <td className="px-1.5 py-3 text-right font-medium text-foreground whitespace-nowrap">
        {formatCurrency(row.paid)}
      </td>
      {/* 13. Outstanding */}
      <td className="px-1.5 py-3 text-right hidden md:table-cell text-muted-foreground whitespace-nowrap">
        {formatCurrency(row.outstanding)}
      </td>
      {/* 14. Paid % */}
      <td className="px-1.5 py-3 text-right hidden sm:table-cell font-medium">
        {row.paidPercent === null ? "—" : `${row.paidPercent.toFixed(0)}%`}
      </td>
    </tr>
  );
}

function GroupedRows({ group, t, lang }: { group: any, t: any, lang: string }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <>
      <tr className="bg-muted/40 font-medium text-foreground border-t-2 border-border/50">
        <td className="px-1.5 py-2 sticky left-0 bg-muted/40 z-10 shadow-[1px_0_0_0_hsl(var(--border))] overflow-hidden">
          <button
            className="flex items-center gap-2 hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm w-full text-left"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={`${expanded ? (lang === "fr" ? "Réduire" : "Recolher") : (lang === "fr" ? "Développer" : "Expandir")} ${group.name}`}
            data-testid={`education-group-toggle-${group.name}`}
          >
            {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <span className="max-w-full truncate" title={group.name}>{group.name}</span>
              <Badge variant="outline" className="font-normal text-[10px] py-0 h-4 bg-background/50">
                {group.rows.length} {t("edu.summary.total_eventos")} {lang === "fr" ? "sur cette page" : "nesta página"}
              </Badge>
            </span>
          </button>
        </td>

        {/* Fill the hidden columns to keep alignment */}
        <td className="px-1.5 py-2 hidden md:table-cell"></td>
        <td className="px-1.5 py-2 hidden lg:table-cell"></td>
        <td className="px-1.5 py-2 hidden lg:table-cell"></td>
        <td className="px-1.5 py-2"></td>
        <td className="px-1.5 py-2 hidden lg:table-cell"></td>

        {/* Totals */}
        <td className="px-1.5 py-2 text-right">{group.totals.enrolled}</td>
        <td className="px-1.5 py-2 text-right hidden sm:table-cell text-muted-foreground">
          {group.totals.available === null ? "—" : (
            <>{group.totals.available} <span className="text-xs">/ {group.totals.capacity}</span></>
          )}
        </td>
        <td className="px-1.5 py-2 text-right hidden xl:table-cell text-muted-foreground whitespace-nowrap">{formatCurrency(group.totals.contracted)}</td>
        <td className="px-1.5 py-2 text-right whitespace-nowrap">{formatCurrency(group.totals.paid)}</td>
        <td className="px-1.5 py-2 text-right hidden md:table-cell text-muted-foreground whitespace-nowrap">{formatCurrency(group.totals.outstanding)}</td>
        <td className="px-1.5 py-2 text-right hidden sm:table-cell">
          {group.totals.paidPercent === null ? "—" : `${group.totals.paidPercent.toFixed(0)}%`}
        </td>
      </tr>
      {expanded && group.rows.map((row: any) => (
        <RowItem key={row.eventId} row={row} t={t} lang={lang} isSubRow={true} />
      ))}
    </>
  );
}
