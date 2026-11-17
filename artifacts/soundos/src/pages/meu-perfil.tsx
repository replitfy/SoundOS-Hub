import { useState, type FormEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { User, Lock, Check } from "lucide-react";
import { toast } from "sonner";
import { useUserSession } from "@/contexts/user-session";
import { useAccess } from "@/contexts/access";
import { useLang } from "@/contexts/language";
import { profileLabel } from "@/lib/access-labels";

export default function MeuPerfil() {
  const { user, login, authHeader } = useUserSession();
  const { profileName, isAdmin } = useAccess();
  const { t } = useLang();

  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [savingInfo, setSavingInfo] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPw, setSavingPw] = useState(false);

  if (!user) return null;

  const handleSaveInfo = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setSavingInfo(true);
    try {
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error((data as { error?: string }).error ?? "Erro ao salvar.");
        return;
      }
      const updated = await res.json();
      login({ ...user, name: updated.name, email: updated.email });
      toast.success("Perfil atualizado.");
    } catch {
      toast.error("Erro de conexão.");
    } finally {
      setSavingInfo(false);
    }
  };

  const handleSavePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword || !confirmPassword) return;
    if (newPassword.length < 8) {
      toast.error("Nova senha deve ter ao menos 8 caracteres.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("As senhas não coincidem.");
      return;
    }
    setSavingPw(true);
    try {
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error((data as { error?: string }).error ?? "Erro ao alterar senha.");
        return;
      }
      toast.success("Senha alterada com sucesso.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      toast.error("Erro de conexão.");
    } finally {
      setSavingPw(false);
    }
  };

  const initials = name.split(" ").map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground mb-1 flex items-center gap-2">
          <User className="h-6 w-6 text-primary" />
          Meu Perfil
        </h1>
        <p className="text-muted-foreground text-sm">Gerencie suas informações de acesso.</p>
      </div>

      {/* Avatar + role */}
      <Card className="shadow-sm border-border/50">
        <CardContent className="pt-5 pb-4 px-5">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <span className="text-primary font-bold text-xl">{initials || "?"}</span>
            </div>
            <div>
              <div className="text-base font-semibold text-foreground">{user.name}</div>
              <div className="text-sm text-muted-foreground mb-1.5">{user.email}</div>
              {profileName && (
                <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${isAdmin ? "bg-violet-100 text-violet-800 border-violet-200" : "bg-emerald-100 text-emerald-800 border-emerald-200"}`}>
                  {profileLabel(profileName, t)}
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Edit info */}
      <Card className="shadow-sm border-border/50">
        <CardHeader className="py-3 px-5 border-b border-border/40">
          <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
            <User className="h-3.5 w-3.5" />
            Dados pessoais
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 py-4">
          <form onSubmit={handleSaveInfo} className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm">Nome</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Seu nome" disabled={savingInfo} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">E-mail</Label>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="seu@email.com" disabled={savingInfo} />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={savingInfo || !name.trim() || !email.trim()}>
                <Check className="h-3.5 w-3.5 mr-1.5" />
                {savingInfo ? "Salvando…" : "Salvar dados"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Change password */}
      <Card className="shadow-sm border-border/50">
        <CardHeader className="py-3 px-5 border-b border-border/40">
          <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
            <Lock className="h-3.5 w-3.5" />
            Alterar senha
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 py-4">
          <form onSubmit={handleSavePassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm">Senha atual</Label>
              <Input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="••••••••" disabled={savingPw} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Nova senha</Label>
              <Input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Mínimo 8 caracteres" disabled={savingPw} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Confirmar nova senha</Label>
              <Input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="••••••••" disabled={savingPw} />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={savingPw || !currentPassword || !newPassword || !confirmPassword}>
                <Lock className="h-3.5 w-3.5 mr-1.5" />
                {savingPw ? "Alterando…" : "Alterar senha"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
