import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Download, Loader2, AlertCircle, Upload, CheckCircle2, XCircle, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useUserSession } from "@/contexts/user-session";
import { redirectToLoginExpired } from "@/lib/auth-error";
import { useLang } from "@/contexts/language";

// Deve espelhar TABLE_MAP no backend. Não há tabela `students`: um aluno é uma
// pessoa do CRM, e a matrícula é que faz o vínculo com a turma.
const ALL_TABLE_IDS = [
  "users", "courses", "classes", "enrollments",
  "knowledge_items", "prompts", "conversations", "messages",
];

type RestoreResult = {
  table: string;
  rows: number;
  status: "ok" | "error";
  error?: string;
};

type PendingRestore = {
  /** Parsed JSON from the file, ready to POST */
  payload: Record<string, unknown>;
  /** Preview: table → row count extracted from the file */
  preview: { table: string; rows: number }[];
};

export default function AdminBackup() {
  // Backup e restauração usam a sessão de admin já ativa no app (mesmo
  // Authorization: Bearer das demais rotas /admin). Não há mais uma chave
  // separada para digitar.
  const { authHeader } = useUserSession();
  const [selected, setSelected] = useState<Set<string>>(new Set(ALL_TABLE_IDS));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreResults, setRestoreResults] = useState<RestoreResult[] | null>(null);

  /** File that was parsed and is awaiting admin confirmation */
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useLang();

  const tableLabels: Record<string, string> = {
    users:           t("admin.bkp.tbl_users"),
    courses:         t("admin.bkp.tbl_courses"),
    classes:         t("admin.bkp.tbl_classes"),
    students:        t("admin.bkp.tbl_students"),
    enrollments:     t("admin.bkp.tbl_enrollments"),
    knowledge_items: t("admin.bkp.tbl_knowledge"),
    prompts:         t("admin.bkp.tbl_prompts"),
    conversations:   t("admin.bkp.tbl_conversations"),
    messages:        t("admin.bkp.tbl_messages"),
  };

  const toggleTable = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === ALL_TABLE_IDS.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(ALL_TABLE_IDS));
    }
  };

  const handleBackup = async () => {
    if (selected.size === 0) return;

    setLoading(true);
    setError(null);
    try {
      const tables = Array.from(selected).join(",");
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/api/admin/backup?tables=${encodeURIComponent(tables)}`, {
        headers: authHeader,
      });

      if (res.status === 401) {
        redirectToLoginExpired();
        return;
      }

      if (res.status === 403) {
        setError("Apenas administradores podem gerar backup.");
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Erro ${res.status}`);
      }

      const blob = await res.blob();
      const now = new Date().toISOString().slice(0, 16).replace(":", "-");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `soundos-backup-${now}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido ao gerar backup.");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Step 1 — parse the chosen file and open the confirmation dialog.
   * Does NOT send anything to the server yet.
   */
  const handleRestoreFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset the input so the same file can be re-selected if the user cancels
    e.target.value = "";

    setRestoreError(null);
    setRestoreResults(null);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(reader.result as string);
        } catch {
          setRestoreError("Arquivo inválido. O arquivo deve ser um JSON válido.");
          return;
        }

        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("_meta" in parsed) ||
          typeof (parsed as Record<string, unknown>)._meta !== "object"
        ) {
          setRestoreError("Formato inválido. O arquivo não parece ser um backup gerado por esta aplicação.");
          return;
        }

        const payload = parsed as Record<string, unknown>;

        // Build a preview: tables present in the file (in restore order) with row counts
        const preview = ALL_TABLE_IDS
          .filter(t => t in payload && Array.isArray(payload[t]))
          .map(t => ({ table: t, rows: (payload[t] as unknown[]).length }));

        if (preview.length === 0) {
          setRestoreError("Nenhuma tabela válida encontrada no arquivo de backup.");
          return;
        }

        setPendingRestore({ payload, preview });
      } catch (err) {
        setRestoreError(err instanceof Error ? err.message : "Erro desconhecido ao ler o arquivo.");
      }
    };
    reader.readAsText(file);
  };

  /**
   * Step 2 — admin confirmed: send to server.
   */
  const handleRestoreConfirm = async () => {
    if (!pendingRestore) return;

    setPendingRestore(null);
    setRestoreLoading(true);
    setRestoreError(null);
    setRestoreResults(null);

    try {
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/api/admin/restore`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        body: JSON.stringify(pendingRestore.payload),
      });

      if (res.status === 401) {
        redirectToLoginExpired();
        return;
      }

      if (res.status === 403) {
        throw new Error("Apenas administradores podem restaurar backup.");
      }

      const body = await res.json().catch(() => ({})) as { results?: RestoreResult[]; error?: string };

      if (!res.ok) {
        throw new Error(body.error ?? `Erro ${res.status}`);
      }

      setRestoreResults(body.results ?? []);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Erro desconhecido ao restaurar backup.");
    } finally {
      setRestoreLoading(false);
    }
  };

  const allSelected = selected.size === ALL_TABLE_IDS.length;
  const noneSelected = selected.size === 0;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("admin.backup.title")}</h1>
        <p className="text-muted-foreground">{t("admin.backup.subtitle")}</p>
      </div>

      <Card className="shadow-sm border-border/50 max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">{t("admin.backup.exportar")}</CardTitle>
          <CardDescription>{t("admin.backup.escolha")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-border/50">
            <Checkbox
              id="select-all"
              checked={allSelected}
              onCheckedChange={toggleAll}
            />
            <Label htmlFor="select-all" className="cursor-pointer font-medium">
              {allSelected ? t("admin.backup.desmarcar") : t("admin.backup.selecionar")}
            </Label>
          </div>

          <div className="grid grid-cols-1 gap-3">
            {ALL_TABLE_IDS.map(id => (
              <div key={id} className="flex items-center gap-3">
                <Checkbox
                  id={id}
                  checked={selected.has(id)}
                  onCheckedChange={() => toggleTable(id)}
                />
                <Label htmlFor={id} className="cursor-pointer">
                  {tableLabels[id]}
                  <span className="ml-2 text-xs text-muted-foreground font-mono">{id}</span>
                </Label>
              </div>
            ))}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleBackup}
            disabled={loading || noneSelected}
            className="w-full mt-2"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("admin.backup.gerando")}
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                {t("admin.backup.gerar")} ({selected.size} {selected.size === 1 ? t("admin.backup.tabela") : t("admin.backup.tabelas")})
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-sm border-border/50 max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">{t("admin.backup.restaurar")}</CardTitle>
          <CardDescription>{t("admin.backup.restaurar_desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleRestoreFileChange}
          />

          {restoreError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{restoreError}</AlertDescription>
            </Alert>
          )}

          {restoreResults && restoreResults.length > 0 && (
            <div className="space-y-2">
              {restoreResults.map(r => (
                <div
                  key={r.table}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                    r.status === "ok"
                      ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950"
                      : "border-destructive/30 bg-destructive/5"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {r.status === "ok" ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive shrink-0" />
                    )}
                    <span className="font-medium">{tableLabels[r.table] ?? r.table}</span>
                    <span className="text-muted-foreground font-mono text-xs">{r.table}</span>
                  </div>
                  <div className="text-right">
                    {r.status === "ok" ? (
                      <span className="text-green-700 dark:text-green-400">
                        {r.rows} {r.rows === 1 ? t("admin.backup.registros") : t("admin.backup.registros_pl")}
                      </span>
                    ) : (
                      <span className="text-destructive text-xs">{r.error ?? t("common.erro")}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={restoreLoading}
            variant="outline"
            className="w-full"
          >
            {restoreLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("admin.backup.restaurando")}
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                {t("admin.backup.selec_arq")}
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* ── Confirmation dialog ─────────────────────────────────────── */}
      <AlertDialog open={pendingRestore !== null} onOpenChange={open => { if (!open) setPendingRestore(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-5 w-5 text-destructive shrink-0" />
              {t("admin.backup.confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t("admin.backup.confirm_desc")}</p>

                {/* Table / row count preview */}
                {pendingRestore && (
                  <div className="rounded-md border border-border bg-muted/50 p-3 space-y-1">
                    <p className="text-xs font-medium text-foreground mb-2">
                      {t("admin.backup.confirm_tabelas")}
                    </p>
                    {pendingRestore.preview.map(({ table, rows }) => (
                      <div key={table} className="flex items-center justify-between text-xs">
                        <span className="font-medium">{tableLabels[table] ?? table}</span>
                        <span className="text-muted-foreground font-mono">
                          {rows} {rows === 1 ? t("admin.backup.registros") : t("admin.backup.registros_pl")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <p className="text-xs font-semibold text-destructive">
                  {t("admin.backup.confirm_warn")}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("admin.backup.cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleRestoreConfirm}
            >
              {t("admin.backup.confirm_btn")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
