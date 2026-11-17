import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAirtableCargaQueryKey,
  useGetAirtableCarga,
  useStartAirtableCargaLoad,
  useStartAirtableCargaPreview,
} from "@workspace/api-client-react";
import type { AirtableCargaRun, ApiError } from "@workspace/api-client-react";
import { AlertCircle, CheckCircle2, CloudDownload, Info, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLang, type TranslationKey } from "@/contexts/language";
import { formatDateTimeSecondsBR } from "@/lib/date";

const POLL_RUNNING_MS = 2000;

type Translate = (key: TranslationKey) => string;

function fill(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((result, [key, value]) => result.split(`{${key}}`).join(String(value)), text);
}

/** Texto do código de erro estável da API; códigos desconhecidos caem no texto genérico. */
function errorText(t: Translate, code: string | null | undefined): string {
  if (!code) return t("carga.err.generic");
  const key = `carga.err.${code}` as TranslationKey;
  const text = t(key);
  return text === key ? t("carga.err.generic") : text;
}

function errorCodeOf(error: unknown): string | null {
  return (error as ApiError<{ code?: string }> | null)?.data?.code ?? null;
}

function StatTile({ label, value, testId, tone }: { label: string; value: string; testId: string; tone?: "primary" }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-4" data-testid={testId}>
      <div className={`text-2xl font-semibold tabular-nums ${tone === "primary" ? "text-primary" : "text-foreground"}`}>{value}</div>
      <div className="text-sm text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

function StatusBadge({ run, t }: { run: AirtableCargaRun; t: Translate }) {
  const label = t(`carga.history.status.${run.status}` as TranslationKey);
  if (run.status === "failed") return <Badge variant="destructive">{label}</Badge>;
  if (run.status === "running") return <Badge variant="secondary">{label}</Badge>;
  return <Badge variant="outline">{label}</Badge>;
}

export default function CargaAirtable() {
  const { t, lang } = useLang();
  const queryClient = useQueryClient();
  const number = new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "pt-BR");

  const state = useGetAirtableCarga({
    query: {
      queryKey: getGetAirtableCargaQueryKey(),
      refetchInterval: (query) => (query.state.data?.runs.some((run) => run.status === "running") ? POLL_RUNNING_MS : false),
    },
  });
  const startPreview = useStartAirtableCargaPreview();
  const startLoad = useStartAirtableCargaLoad();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [dialogClock, setDialogClock] = useState(() => new Date());
  const [actionError, setActionError] = useState<string | null>(null);

  const runs = state.data?.runs ?? [];
  const settings = state.data?.settings;
  const running = runs.find((run) => run.status === "running") ?? null;
  const newest = runs[0] ?? null;
  const latestPreview = runs.find((run) => run.kind === "preview" && run.status === "completed") ?? null;
  const usable = runs.find((run) => run.usableForLoad) ?? null;
  const busy = running !== null || startPreview.isPending || startLoad.isPending;

  // A hora mostrada na confirmação corre enquanto o diálogo está aberto.
  useEffect(() => {
    if (!dialogOpen) return undefined;
    setDialogClock(new Date());
    const timer = window.setInterval(() => setDialogClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [dialogOpen]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetAirtableCargaQueryKey() });

  const handlePreview = () => {
    setActionError(null);
    startPreview.mutate(undefined, {
      onSuccess: () => { void refresh(); },
      onError: (error) => {
        setActionError(errorText(t, errorCodeOf(error)));
        void refresh();
      },
    });
  };

  const handleLoad = () => {
    if (!usable || !confirmed) return;
    setActionError(null);
    startLoad.mutate(
      { data: { previewRunId: usable.id, restoreConfirmed: true } },
      {
        onSuccess: () => {
          setDialogOpen(false);
          setConfirmed(false);
          void refresh();
        },
        onError: (error) => {
          setDialogOpen(false);
          setConfirmed(false);
          setActionError(errorText(t, errorCodeOf(error)));
          toast.error(errorText(t, errorCodeOf(error)));
          void refresh();
        },
      },
    );
  };

  const lastRead = runs.find((run) => run.status === "completed" && run.sourceRecordsRead);
  const guardLimit = settings
    ? Math.floor((lastRead?.sourceRecordsRead ?? settings.referenceRecords) * settings.minimumFraction)
    : null;

  const totals = latestPreview?.totals ?? null;
  const previewProblem = (() => {
    if (!latestPreview) return null;
    if (usable) return null;
    if (latestPreview.totals && latestPreview.totals.enrollments === null) return t("carga.preview.legacy");
    if (latestPreview.totals && latestPreview.totals.toCreate === 0) return t("carga.preview.nothing");
    const consumed = runs.some((run) => run.kind === "load" && run.previewRunId === latestPreview.id && run.status !== "failed");
    if (consumed) return t("carga.preview.used");
    return t("carga.preview.expired");
  })();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1" data-testid="carga-title">{t("carga.title")}</h1>
        <p className="text-muted-foreground">{t("carga.subtitle")}</p>
      </div>

      <Card className="shadow-sm border-border/50">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Info className="h-4 w-4" />{t("carga.rules.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
            <li>{t("carga.rules.1")}</li>
            <li>{t("carga.rules.2")}</li>
            <li>{t("carga.rules.3")}</li>
            <li>{t("carga.rules.4")}</li>
            <li>{t("carga.rules.5")}</li>
          </ul>
          {guardLimit !== null && (
            <p className="text-sm text-muted-foreground mt-3" data-testid="carga-guard">
              {fill(t("carga.guard"), { n: number.format(guardLimit) })}
            </p>
          )}
        </CardContent>
      </Card>

      {state.isError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{t("carga.error.load_state")}</AlertDescription>
        </Alert>
      )}

      {running && (
        <Alert data-testid="carga-running">
          <Loader2 className="h-4 w-4 animate-spin" />
          <AlertTitle>{t(running.kind === "load" ? "carga.running.title.load" : "carga.running.title.preview")}</AlertTitle>
          <AlertDescription className="space-y-1">
            <p className="font-medium" data-testid="carga-step">
              {running.step ? t(`carga.step.${running.step}` as TranslationKey) : "…"}
            </p>
            <p>
              {t(running.kind === "load" ? "carga.running.restore_reference" : "carga.running.started_at")}:{" "}
              <span className="font-mono" data-testid="carga-started-at">{formatDateTimeSecondsBR(running.startedAt)}</span>
            </p>
            <p>{t("carga.running.keep_open")}</p>
          </AlertDescription>
        </Alert>
      )}

      {!running && actionError && (
        <Alert variant="destructive" data-testid="carga-action-error">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {!running && newest && newest.status === "failed" && (
        <Alert variant="destructive" data-testid="carga-last-failed">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{newest.kind === "load" ? t("carga.result.failed") : t("carga.preview.failed")}</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>{errorText(t, newest.errorCode)}</p>
            {newest.reconciliation && (
              <ul className="list-disc pl-5">
                {newest.reconciliation.checks.filter((check) => !check.ok).map((check) => (
                  <li key={check.name}>{t(`carga.check.${check.name}` as TranslationKey)}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {!running && newest && newest.kind === "load" && newest.status === "completed" && (
        <Alert data-testid="carga-last-done">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertTitle>
            {fill(t("carga.result.load_done"), {
              n: number.format(newest.created ?? 0),
              m: number.format(newest.enrollmentsCreated ?? 0),
            })}
          </AlertTitle>
          <AlertDescription>
            {newest.reconciliation?.passed ? t("carga.result.reconciliation_ok") : null}
          </AlertDescription>
        </Alert>
      )}

      <Card className="shadow-sm border-border/50">
        <CardHeader>
          <CardTitle className="text-base">{t("carga.preview.title")}</CardTitle>
          <CardDescription>{t("carga.preview.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={handlePreview} disabled={busy} data-testid="carga-preview-button">
            {startPreview.isPending || running?.kind === "preview"
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <CloudDownload className="mr-2 h-4 w-4" />}
            {t("carga.preview.button")}
          </Button>

          {!latestPreview && !state.isLoading && (
            <p className="text-sm text-muted-foreground">{t("carga.preview.none")}</p>
          )}

          {latestPreview && totals && (
            <div className="space-y-4" data-testid="carga-totals">
              <p className="text-sm text-muted-foreground">
                {t("carga.preview.generated_at")} {formatDateTimeSecondsBR(latestPreview.finishedAt)}
                {latestPreview.validUntil && !previewProblem
                  ? ` · ${t("carga.preview.valid_until")} ${formatDateTimeSecondsBR(latestPreview.validUntil)}`
                  : ""}
              </p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatTile testId="carga-total-read" label={t("carga.total.read")} value={number.format(totals.sourceRecords)} />
                <StatTile testId="carga-total-create" label={t("carga.total.create")} value={number.format(totals.toCreate)} tone="primary" />
                <StatTile testId="carga-total-exist" label={t("carga.total.exist")} value={number.format(totals.alreadyExist)} />
                <StatTile testId="carga-total-review" label={t("carga.total.review")} value={number.format(totals.review.total)} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <dl className="space-y-1">
                  {(["email", "phone", "both", "previousLoad"] as const).map((via) => (
                    <div key={via} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{t(`carga.exist.${via}` as TranslationKey)}</dt>
                      <dd className="tabular-nums">{number.format(totals.alreadyExistBy[via])}</dd>
                    </div>
                  ))}
                </dl>
                <dl className="space-y-1">
                  {(["duplicado_no_airtable", "ambiguo", "contraditorio", "dados_insuficientes"] as const).map((reason) => (
                    <div key={reason} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{t(`carga.review.${reason}` as TranslationKey)}</dt>
                      <dd className="tabular-nums">{number.format(totals.review.byReason[reason])}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              {totals.enrollments && (
                <div className="space-y-3" data-testid="carga-enrollments">
                  <h3 className="text-sm font-semibold text-foreground">{t("carga.enroll.title")}</h3>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <StatTile
                      testId="carga-enroll-for-new"
                      label={t("carga.enroll.forNewClients")}
                      value={number.format(totals.enrollments.forNewClients)}
                    />
                    <StatTile
                      testId="carga-enroll-create"
                      label={t("carga.enroll.create")}
                      value={number.format(totals.enrollments.toCreate)}
                      tone="primary"
                    />
                    <StatTile
                      testId="carga-enroll-clients"
                      label={t("carga.enroll.clients")}
                      value={number.format(totals.enrollments.clientsWithEnrollment)}
                    />
                    <StatTile
                      testId="carga-enroll-review"
                      label={t("carga.enroll.review")}
                      value={number.format(totals.enrollments.review.total)}
                    />
                  </div>
                  <dl className="space-y-1 text-sm max-w-md">
                    {(["turma_ausente", "turma_ambigua", "duplicada", "pessoa_ambigua"] as const).map((reason) => (
                      <div key={reason} className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{t(`carga.enroll.review.${reason}` as TranslationKey)}</dt>
                        <dd className="tabular-nums">{number.format(totals.enrollments!.review.byReason[reason])}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              {previewProblem && <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="carga-preview-problem">{previewProblem}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm border-border/50">
        <CardHeader>
          <CardTitle className="text-base">{t("carga.load.title")}</CardTitle>
          <CardDescription>{t("carga.load.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="destructive"
            disabled={busy || !usable}
            onClick={() => { setConfirmed(false); setDialogOpen(true); }}
            data-testid="carga-load-button"
          >
            <ShieldAlert className="mr-2 h-4 w-4" />
            {t("carga.load.button")}
          </Button>
          {!usable && <p className="text-sm text-muted-foreground">{t("carga.load.needs_preview")}</p>}
        </CardContent>
      </Card>

      <Card className="shadow-sm border-border/50">
        <CardHeader>
          <CardTitle className="text-base">{t("carga.history.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("carga.history.empty")}</p>
          ) : (
            <Table data-testid="carga-history">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("carga.history.when")}</TableHead>
                  <TableHead>{t("carga.history.kind")}</TableHead>
                  <TableHead>{t("carga.history.by")}</TableHead>
                  <TableHead>{t("carga.history.status")}</TableHead>
                  <TableHead>{t("carga.history.result")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{formatDateTimeSecondsBR(run.startedAt)}</TableCell>
                    <TableCell>
                      {t(`carga.history.kind.${run.kind}` as TranslationKey)}
                      {run.kind === "load" && run.previewRunId !== null && (
                        <span className="block text-xs text-muted-foreground">
                          {fill(t("carga.history.from_preview"), { id: run.previewRunId })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{run.requestedBy?.name ?? "—"}</TableCell>
                    <TableCell><StatusBadge run={run} t={t} /></TableCell>
                    <TableCell className="text-sm">
                      {run.status === "failed"
                        ? errorText(t, run.errorCode)
                        : run.kind === "load" && run.status === "completed"
                          ? fill(t("carga.history.load_result"), {
                            n: number.format(run.created ?? 0),
                            m: number.format(run.enrollmentsCreated ?? 0),
                          })
                          : run.totals
                            ? fill(t("carga.history.preview_result"), {
                              read: number.format(run.totals.sourceRecords),
                              create: number.format(run.totals.toCreate),
                              exist: number.format(run.totals.alreadyExist),
                              review: number.format(run.totals.review.total),
                            }) + (run.totals.enrollments
                              ? fill(t("carga.history.preview_enrollments"), { n: number.format(run.totals.enrollments.toCreate) })
                              : "")
                            : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={dialogOpen} onOpenChange={(open) => { if (!startLoad.isPending) setDialogOpen(open); }}>
        <AlertDialogContent data-testid="carga-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("carga.dialog.title")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p className="font-medium text-foreground">
                  {fill(t("carga.dialog.summary"), {
                    n: number.format(usable?.totals?.toCreate ?? 0),
                    m: number.format(usable?.totals?.enrollments?.toCreate ?? 0),
                  })}
                </p>
                <p>{t("carga.dialog.pitr")}</p>
                <p>
                  {fill(t("carga.dialog.reference"), { time: formatDateTimeSecondsBR(dialogClock) })}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-start gap-2">
            <Checkbox
              id="carga-restore-confirmed"
              checked={confirmed}
              onCheckedChange={(value) => setConfirmed(value === true)}
              data-testid="carga-confirm-checkbox"
            />
            <Label htmlFor="carga-restore-confirmed" className="cursor-pointer leading-snug">{t("carga.dialog.check")}</Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={startLoad.isPending}>{t("carga.dialog.cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!confirmed || startLoad.isPending}
              onClick={handleLoad}
              data-testid="carga-confirm-button"
            >
              {startLoad.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("carga.dialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
