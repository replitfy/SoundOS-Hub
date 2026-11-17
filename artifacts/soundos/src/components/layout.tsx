import { useLocation } from "wouter";
import { LayoutGrid, DollarSign, ShoppingBag, ShoppingCart, Package, Users, GraduationCap, CalendarDays, Bot, BrainCircuit, MessageSquareCode, MessageCircle, Film, Settings, KeySquare, ChevronDown, Download, LogOut, UserCog, Send, PanelLeftClose, PanelLeftOpen, Handshake, ShieldCheck, CloudDownload } from "lucide-react";
import logoPath from "@/assets/logotipo-soundos.png";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { useAccess } from "@/contexts/access";
import { profileLabel } from "@/lib/access-labels";
import { VersionBadge } from "@/components/version-badge";
import { textoAguardandoEquipe, textoRespostasNaoEntregues, useConversasAguardandoEquipe } from "@/hooks/use-conversas-aguardando";

interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  /** Pendências que pedem atenção de quem atende (ex.: conversas aguardando a equipe). */
  aviso?: number;
  /** Conversas cuja última resposta da Sofia não foi entregue (contador próprio, ao lado do aviso). */
  avisoEnvio?: number;
}

interface NavSection {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  color?: string;
  children: NavItem[];
}

function ContadorDeAviso({ total, className = "", compacto = false, tipo = "aguardando" }: { total: number; className?: string; compacto?: boolean; tipo?: "aguardando" | "nao_entregue" }) {
  const { t } = useLang();
  if (total <= 0) return null;
  const naoEntregue = tipo === "nao_entregue";
  const texto = naoEntregue ? textoRespostasNaoEntregues(t, total) : textoAguardandoEquipe(t, total);
  return (
    <span
      role="status"
      aria-label={texto}
      title={texto}
      data-testid={naoEntregue ? "badge-respostas-nao-entregues" : "badge-conversas-aguardando"}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${naoEntregue ? "bg-red-600" : "bg-amber-500"} font-bold leading-none text-white ${compacto ? "h-3.5 min-w-3.5 px-0.5 text-[9px]" : "h-4 min-w-4 px-1 text-[10px]"} ${className}`}
    >
      {total > 99 ? "99+" : total}
    </span>
  );
}

function LangSwitcher() {
  const { lang, setLang } = useLang();
  return (
    <div className="fixed top-3 right-4 z-50 flex items-center gap-0.5 bg-background/90 backdrop-blur-sm border border-border/60 rounded-full px-1 py-0.5 shadow-sm">
      <button
        onClick={() => setLang("pt")}
        title="Português"
        className={`px-2 py-0.5 rounded-full text-sm transition-colors ${lang === "pt" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        🇧🇷
      </button>
      <button
        onClick={() => setLang("fr")}
        title="Français"
        className={`px-2 py-0.5 rounded-full text-sm transition-colors ${lang === "fr" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        🇫🇷
      </button>
    </div>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("soundos_sidebar_collapsed") === "1";
  });
  const { requestNavigate } = useUnsavedGuard();
  const { t } = useLang();
  const { user, logout } = useUserSession();
  const access = useAccess();
  const abrirConversas = useCallback(() => requestNavigate("/sofia/conversas"), [requestNavigate]);
  const { aguardando: conversasAguardando, naoEntregues: respostasNaoEntregues } = useConversasAguardandoEquipe(abrirConversas);

  const ALL_NAV_ITEMS: NavSection[] = [
    {
      id: "dashboard",
      label: t("nav.section.overview"),
      icon: LayoutGrid,
      children: [
        { id: "visao-geral",     label: t("nav.dashboard"),     href: "/",            icon: LayoutGrid },
        { id: "visao-financeira", label: t("nav.financeiro"),   href: "/financeiro",  icon: DollarSign },
        { id: "painel-loja",      label: t("nav.painel-loja"),  href: "/store",       icon: ShoppingBag },
        { id: "painel-escola",    label: t("nav.painel-escola"), href: "/education",  icon: GraduationCap },
      ],
    },
    {
      id: "cockpit",
      label: t("nav.section.cockpit"),
      icon: ShoppingCart,
      children: [
        { id: "pessoas",  label: t("nav.pessoas"),  href: "/pessoas",           icon: Users },
        { id: "crm",      label: t("nav.crm"),      href: "/crm",               icon: Handshake },
        { id: "produtos", label: t("nav.produtos"), href: "/store/produtos",    icon: Package },
        { id: "eventos",  label: t("nav.eventos"),  href: "/education/cursos",  icon: CalendarDays },
      ],
    },
    {
      id: "sofia",
      label: t("nav.section.sofia"),
      icon: Bot,
      color: "var(--color-sofia)",
      children: [
        { id: "chat",      label: t("nav.chat"),      href: "/sofia",          icon: Bot },
        { id: "memoria",   label: t("nav.memoria"),   href: "/sofia/memoria",  icon: BrainCircuit },
        { id: "prompt",    label: t("nav.prompt"),    href: "/sofia/prompt",   icon: MessageSquareCode },
        { id: "conduta",   label: t("nav.conduta"),   href: "/sofia/conduta",  icon: Handshake },
        { id: "conversas", label: t("nav.conversas"), href: "/sofia/conversas", icon: MessageCircle, aviso: conversasAguardando, avisoEnvio: respostasNaoEntregues },
        { id: "videos",    label: t("nav.videos"),    href: "/sofia/videos",    icon: Film },
        { id: "videos-envios", label: t("nav.videos_envios"), href: "/sofia/videos/envios", icon: Send },
      ],
    },
    {
      id: "administracao",
      label: t("nav.section.admin"),
      icon: Settings,
      children: [
        { id: "usuarios",   label: t("nav.usuarios"),   href: "/admin/usuarios",   icon: KeySquare },
        { id: "perfis",     label: t("nav.perfis"),     href: "/admin/perfis",     icon: ShieldCheck },
        { id: "backup",           label: t("nav.backup"),           href: "/admin/backup",           icon: Download },
        { id: "carga-airtable", label: t("nav.carga_airtable"), href: "/admin/manutencao/airtable", icon: CloudDownload },
      ],
    },
  ];

  // O menu mostra só o que o perfil libera; enquanto o perfil não é confirmado, nada restrito aparece.
  const NAV_ITEMS = ALL_NAV_ITEMS
    .map(section => ({ ...section, children: section.children.filter(item => access.can(item.id)) }))
    .filter(section => section.children.length > 0);

  const avisoDaSecao = (section: NavSection) => section.children.reduce((soma, item) => soma + (item.aviso ?? 0), 0);
  const avisoEnvioDaSecao = (section: NavSection) => section.children.reduce((soma, item) => soma + (item.avisoEnvio ?? 0), 0);

  const toggle = (id: string) => {
    setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));
  };

  useEffect(() => {
    window.localStorage.setItem("soundos_sidebar_collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  const initials = user
    ? user.name.split(" ").map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()
    : "?";

  const handleLogout = () => {
    logout();
  };

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      {/* Language switcher — fixed top-right */}
      <LangSwitcher />

      {/* Sidebar — always visible, fixed */}
      <aside className={`${sidebarCollapsed ? "w-14" : "w-56"} shrink-0 bg-sidebar text-sidebar-foreground flex flex-col h-screen sticky top-0 overflow-y-auto overflow-x-visible transition-[width] duration-200`}>
        {/* Logo */}
        <div className={`py-5 flex items-center ${sidebarCollapsed ? "justify-center px-2" : "justify-between px-5 gap-3"}`}>
          {!sidebarCollapsed && (
            <div className="flex items-center gap-3 min-w-0">
              <img src={logoPath} alt="Soundfulness" className="h-8 w-auto object-contain shrink-0" />
              <div className="flex flex-col leading-tight min-w-0">
                <span className="text-base font-bold uppercase text-sidebar-foreground" style={{ fontFamily: "'Montserrat', sans-serif", letterSpacing: "0.38em" }}>Sound</span>
                <span className="text-[9px] font-semibold uppercase text-sidebar-foreground/50" style={{ fontFamily: "'Montserrat', sans-serif", letterSpacing: "0.22em", marginTop: "-1px" }}>Operation System</span>
              </div>
            </div>
          )}
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? t("nav.expandir_menu") : t("nav.recolher_menu")}
            data-testid="button-toggle-sidebar"
            className="shrink-0 flex items-center justify-center h-7 w-7 rounded-md text-sidebar-foreground/50 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground transition-colors"
          >
            {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2.5 space-y-1">
          {NAV_ITEMS.map((section) => {
            const isOpen = !collapsed[section.id];

            if (sidebarCollapsed) {
              return (
                <div key={section.id} className="relative group">
                  <div
                    className="relative w-full flex items-center justify-center py-2 rounded-md transition-colors hover:bg-sidebar-accent/30 cursor-default"
                    style={{ color: section.color ?? "hsl(var(--sidebar-foreground) / 0.45)" }}
                    title={section.label}
                  >
                    <section.icon className="h-3.5 w-3.5 shrink-0" />
                    <ContadorDeAviso total={avisoDaSecao(section)} compacto className="absolute right-0 top-0" />
                    <ContadorDeAviso total={avisoEnvioDaSecao(section)} tipo="nao_entregue" compacto className="absolute bottom-0 right-0" />
                  </div>
                  {/* Flyout with section items on hover */}
                  <div className="hidden group-hover:block absolute left-full top-0 ml-1.5 z-50 w-48 bg-sidebar border border-sidebar-border rounded-md shadow-lg p-1.5">
                    <div className="px-1.5 py-1 text-[10px] font-bold tracking-widest" style={{ color: section.color ?? "hsl(var(--sidebar-foreground) / 0.45)" }}>
                      {section.label}
                    </div>
                    <div className="space-y-0.5">
                      {section.children.map((item) => {
                        const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href + "/"));
                        return (
                          <div
                            key={item.id}
                            data-testid={`nav-${item.id}`}
                            onClick={() => requestNavigate(item.href)}
                            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                              isActive
                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                : "text-sidebar-foreground/65 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
                            }`}
                          >
                            <item.icon className="h-3 w-3 shrink-0 opacity-70" />
                            {item.label}
                            <ContadorDeAviso total={item.aviso ?? 0} className="ml-auto" />
                            <ContadorDeAviso total={item.avisoEnvio ?? 0} tipo="nao_entregue" className={item.aviso ? "" : "ml-auto"} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            }

            return (
              <div key={section.id}>
                <button
                  data-testid={`section-${section.id}`}
                  onClick={() => toggle(section.id)}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md group transition-colors hover:bg-sidebar-accent/30"
                >
                  <div className="flex items-center gap-1.5" style={{ color: section.color ?? "hsl(var(--sidebar-foreground) / 0.45)" }}>
                    <section.icon className="h-3 w-3 shrink-0" />
                    <span className="text-[10px] font-bold tracking-widest">{section.label}</span>
                  </div>
                  {!isOpen && <ContadorDeAviso total={avisoDaSecao(section)} className="ml-auto mr-1.5" />}
                  {!isOpen && <ContadorDeAviso total={avisoEnvioDaSecao(section)} tipo="nao_entregue" className={`mr-1.5 ${avisoDaSecao(section) > 0 ? "" : "ml-auto"}`} />}
                  <ChevronDown
                    className="h-3 w-3 transition-transform duration-200 text-sidebar-foreground/30"
                    style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                  />
                </button>

                {isOpen && (
                  <div className="mt-0.5 mb-1 space-y-0.5 pl-1">
                    {section.children.map((item) => {
                      const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href + "/"));
                      return (
                        <div
                          key={item.id}
                          data-testid={`nav-${item.id}`}
                          onClick={() => requestNavigate(item.href)}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                            isActive
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : "text-sidebar-foreground/65 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
                          }`}
                        >
                          <item.icon className="h-3 w-3 shrink-0 opacity-70" />
                          {item.label}
                          <ContadorDeAviso total={item.aviso ?? 0} className="ml-auto" />
                          <ContadorDeAviso total={item.avisoEnvio ?? 0} tipo="nao_entregue" className={item.aviso ? "" : "ml-auto"} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Footer — user info + actions */}
        <div className={`py-3 border-t border-sidebar-border space-y-1.5 ${sidebarCollapsed ? "px-2" : "px-3"}`}>
          {/* User row */}
          <div className={`flex items-center gap-2.5 ${sidebarCollapsed ? "justify-center" : "px-1"}`}>
            <div className="w-7 h-7 rounded-full bg-sidebar-accent flex items-center justify-center text-xs font-bold shrink-0" title={sidebarCollapsed ? user?.name : undefined}>
              {initials}
            </div>
            {!sidebarCollapsed && (
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate text-sidebar-foreground">{user?.name ?? "—"}</div>
                <div className="text-[10px] text-sidebar-foreground/50">{access.profileName ? profileLabel(access.profileName, t) : "SoundOS"}</div>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className={`flex gap-1 ${sidebarCollapsed ? "flex-col" : ""}`}>
            <button
              onClick={() => requestNavigate("/meu-perfil")}
              title="Editar perfil"
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium text-sidebar-foreground/60 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground transition-colors"
            >
              <UserCog className="h-3 w-3 shrink-0" />
              {!sidebarCollapsed && "Meu perfil"}
            </button>
            <button
              onClick={handleLogout}
              title="Sair"
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium text-sidebar-foreground/60 hover:bg-destructive/20 hover:text-destructive transition-colors"
            >
              <LogOut className="h-3 w-3 shrink-0" />
              {!sidebarCollapsed && "Sair"}
            </button>
          </div>
          {!sidebarCollapsed && <VersionBadge className="block px-1 pt-1 text-[10px] text-sidebar-foreground/40" />}
        </div>
      </aside>

      {/* Main Content */}
      <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
        <div className={`mx-auto min-w-0 ${location === "/pessoas" || location === "/crm" || location === "/store/produtos" || location === "/education" ? "max-w-none" : "max-w-7xl"}`}>
          {children}
        </div>
      </main>
    </div>
  );
}
