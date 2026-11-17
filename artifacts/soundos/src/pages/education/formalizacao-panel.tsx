import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { useUserSession } from "@/contexts/user-session";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { buildFormalizacaoUrl, formalizacaoState, type FormalizacaoInfo } from "@/lib/formalizacao";
import { AlertTriangle, Banknote, Copy, Link2, Ban } from "lucide-react";

const STATE_TONE: Record<string, string> = {
  none: "bg-muted text-muted-foreground",
  pending: "bg-amber-500/10 text-amber-700",
  completed: "bg-emerald-500/10 text-emerald-700",
  revoked: "bg-muted text-muted-foreground line-through",
  expired: "bg-destructive/10 text-destructive",
};

export function FormalizacaoStatus({ f, rowId }: { f: FormalizacaoInfo | null | undefined; rowId: number }) {
  const { t } = useLang();
  const st = formalizacaoState(f);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className={`px-1.5 py-0.5 rounded ${f ? "bg-emerald-500/10 text-emerald-700" : "bg-muted text-muted-foreground"}`} data-testid={`status-payment-${rowId}`}>
        {t("fz.status.payment")}: {f ? `${t("fz.status.paid")} ${f.amount}` : t("fz.status.none")}
      </span>
      {f && (
        <span className={`px-1.5 py-0.5 rounded ${STATE_TONE[st]}`} data-testid={`status-formalizacao-${rowId}`}>
          {t("fz.status.formalization")}: {t(`fz.status.${st}` as never)}
        </span>
      )}
      {f?.reference && <span className="text-muted-foreground font-mono truncate max-w-[160px]" title={f.reference}>{f.reference}</span>}
    </div>
  );
}

export function FormalizacaoActions({ eventoId, preId, nome, f }: { eventoId: number; preId: number; nome: string; f: FormalizacaoInfo | null | undefined }) {
  const { t } = useLang();
  const { authHeader } = useUserSession();
  const qc = useQueryClient();
  const st = formalizacaoState(f);
  const [payOpen, setPayOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["/api/cursos-inscricao", eventoId, "detalhe"] });
  const base = `/api/cursos-inscricao/${eventoId}/preinscricoes/${preId}/pagamento`;

  if (st === "completed") return null;

  const openPay = () => { setAmount(f?.amount ?? ""); setReference(f?.reference ?? ""); setConfirmed(false); setPayOpen(true); };

  const submitPay = async () => {
    setBusy(true);
    try {
      const r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ amount: amount.trim(), reference: reference.trim() }),
      });
      if (!r.ok) throw new Error();
      const body = await r.json() as { token: string; expiresAt: string };
      setLink({ url: buildFormalizacaoUrl(body.token), expiresAt: body.expiresAt });
      setPayOpen(false);
    } catch {
      toast.error(t("fz.dialog.error"));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const submitRevoke = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${base}/revogar`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeader } });
      if (!r.ok) throw new Error();
      toast.success(t("fz.revoke.done"));
      setRevokeOpen(false);
    } catch {
      toast.error(t("fz.revoke.error"));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); toast.success(t("fz.link.copied")); } catch { /* user can select manually */ }
  };

  const valid = amount.trim() !== "" && reference.trim() !== "" && confirmed;

  return (
    <>
      <div className="flex flex-wrap gap-1.5 justify-end">
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={openPay} data-testid={`button-pagamento-${preId}`}>
          {f ? <Link2 className="h-3.5 w-3.5 mr-1.5" /> : <Banknote className="h-3.5 w-3.5 mr-1.5" />}
          {f ? t("fz.action.reissue") : t("fz.action.register")}
        </Button>
        {st === "pending" && (
          <Button size="sm" variant="ghost" className="h-8 text-xs text-destructive hover:text-destructive" onClick={() => setRevokeOpen(true)} data-testid={`button-revogar-${preId}`}>
            <Ban className="h-3.5 w-3.5 mr-1.5" /> {t("fz.action.revoke")}
          </Button>
        )}
      </div>

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("fz.dialog.title")}</DialogTitle>
            <DialogDescription>{nome}. {t("fz.dialog.desc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {f && (
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800" data-testid="text-reissue-warning">
                <AlertTriangle className="h-4 w-4 shrink-0" /> {t("fz.dialog.reissue_warn")}
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="fz-amount">{t("fz.dialog.amount")} *</Label>
              <Input id="fz-amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0,00" data-testid="input-amount" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fz-ref">{t("fz.dialog.reference")} *</Label>
              <Input id="fz-ref" value={reference} onChange={e => setReference(e.target.value)} placeholder={t("fz.dialog.reference_ph")} data-testid="input-reference" />
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <Checkbox checked={confirmed} onCheckedChange={c => setConfirmed(!!c)} data-testid="checkbox-confirm-received" className="mt-0.5" />
              {t("fz.dialog.confirm_check")}
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayOpen(false)}>{t("fz.dialog.cancel")}</Button>
            <Button onClick={submitPay} disabled={!valid || busy} data-testid="button-submit-pagamento">{t("fz.dialog.submit")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!link} onOpenChange={o => { if (!o) setLink(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("fz.link.title")}</DialogTitle>
            <DialogDescription>{t("fz.link.desc")}</DialogDescription>
          </DialogHeader>
          {link && (
            <div className="space-y-2">
              <Input readOnly value={link.url} onFocus={e => e.currentTarget.select()} className="font-mono text-xs" data-testid="input-formalizacao-link" />
              <p className="text-xs text-muted-foreground">{t("fz.public.expires")} {formatDateTimeBR(link.expiresAt)}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLink(null)}>{t("fz.link.close")}</Button>
            <Button onClick={copy} data-testid="button-copy-formalizacao-link"><Copy className="h-4 w-4 mr-2" />{t("fz.link.copy")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("fz.revoke.title")}</DialogTitle>
            <DialogDescription>{t("fz.revoke.desc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeOpen(false)}>{t("fz.dialog.cancel")}</Button>
            <Button variant="destructive" onClick={submitRevoke} disabled={busy} data-testid="button-confirm-revogar">{t("fz.revoke.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
