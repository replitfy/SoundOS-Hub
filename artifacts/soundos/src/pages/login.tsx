import { useState, type FormEvent } from "react";
import { useLocation, useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { VersionBadge } from "@/components/version-badge";
import { Label } from "@/components/ui/label";
import { LogIn, Eye, EyeOff, ShieldAlert } from "lucide-react";
import { useUserSession } from "@/contexts/user-session";
import logoPath from "@/assets/logotipo-soundos.png";

export default function LoginPage() {
  const { login } = useUserSession();
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const nextPath = params.get("next");
  const sessionExpired = params.get("expired") === "1";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    sessionExpired ? "Sua sessão expirou. Entre novamente para continuar." : null,
  );
  const [mustReset, setMustReset] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setLoading(true);
    setError(null);

    setMustReset(false);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (res.status === 401 || res.status === 403) {
        const data = await res.json().catch(() => ({}));
        const body = data as { error?: string; code?: string };
        if (body.code === "PASSWORD_MUST_RESET") {
          setMustReset(true);
          setError(null);
        } else {
          setError("E-mail ou senha incorretos.");
        }
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? "Erro ao entrar. Tente novamente.");
        return;
      }

      const user = await res.json();
      login(user); // já inclui sessionToken emitido pelo servidor
      navigate(nextPath && nextPath.startsWith("/") ? nextPath : "/");
    } catch {
      setError("Erro de conexão. Verifique se o servidor está disponível.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-muted/30 px-4"
      style={{ fontFamily: "var(--font-sans)" }}
    >
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <img src={logoPath} alt="SoundOS" className="h-9 w-auto object-contain" />
          <div className="flex flex-col leading-tight">
            <span className="text-lg font-bold uppercase text-foreground" style={{ fontFamily: "'Montserrat', sans-serif", letterSpacing: "0.38em" }}>Sound</span>
            <span className="text-[9px] font-semibold uppercase text-muted-foreground" style={{ fontFamily: "'Montserrat', sans-serif", letterSpacing: "0.22em", marginTop: "-2px" }}>Operation System</span>
          </div>
        </div>

        <Card className="shadow-md border-border/50">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-lg">Entrar</CardTitle>
            <CardDescription className="text-sm">Use seu e-mail e senha cadastrados.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-sm">E-mail</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="seu@email.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-sm">Senha</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPw ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    disabled={loading}
                    required
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {mustReset && (
                <div className="rounded-md bg-amber-50 border border-amber-300 px-3 py-3 text-sm text-amber-800 flex gap-2.5">
                  <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                  <span>
                    <strong>Redefinição de senha necessária.</strong>{" "}
                    Sua senha ainda não foi configurada no novo formato seguro. Solicite ao administrador que defina uma nova senha para o seu usuário e tente novamente.
                  </span>
                </div>
              )}

              {error && (
                <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={loading || !email || !password}>
                <LogIn className="h-4 w-4 mr-2" />
                {loading ? "Entrando…" : "Entrar"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <div className="mt-4 text-center">
          <VersionBadge className="text-[11px] text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}
