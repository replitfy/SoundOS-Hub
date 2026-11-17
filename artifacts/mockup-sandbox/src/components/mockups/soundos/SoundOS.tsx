import { useState } from "react";

const palette = {
  white: "#FFFFFF",
  warmWhite: "#F8F7F4",
  mistBlue: "#EAF3F8",
  skyBlue: "#BFDDF2",
  instBlue: "#5777A6",
  deepBlue: "#1F344D",
  brown: "#8B5E35",
  softGold: "#C9A45D",
  sand: "#E7D8BE",
  textGray: "#69717C",
  agua: "#5A78A8",
  fogo: "#D94A3A",
  terra: "#5F7F3F",
  ar: "#E5A83B",
  store: "#8A4E2E",
  sofiaBg: "#DDEDF7",
  sofiaAccent: "#C9A45D",
};

type NavItem = {
  id: string;
  label: string;
  icon: string;
  color?: string;
  children?: { id: string; label: string }[];
};

const navItems: NavItem[] = [
  {
    id: "visao-geral",
    label: "VISÃO GERAL",
    icon: "◎",
    children: [
      { id: "dashboard", label: "Dashboard" },
      { id: "financeiro", label: "Financeiro" },
      { id: "comercial", label: "Comercial & Leads" },
      { id: "calendario", label: "Calendário & Eventos" },
    ],
  },
  {
    id: "store",
    label: "STORE",
    icon: "◈",
    color: palette.store,
    children: [
      { id: "painel-loja", label: "Painel da Loja" },
      { id: "pedidos", label: "Pedidos" },
      { id: "produtos", label: "Produtos & Estoque" },
      { id: "clientes-store", label: "Clientes & Fidelidade" },
      { id: "revendedores", label: "Revendedores/Afiliados" },
    ],
  },
  {
    id: "education",
    label: "EDUCATION",
    icon: "◑",
    color: palette.agua,
    children: [
      { id: "painel-escola", label: "Painel da Escola" },
      { id: "cursos", label: "Cursos" },
      { id: "turmas", label: "Turmas" },
      { id: "alunos", label: "Alunos" },
      { id: "matriculas", label: "Matrículas & Pagamentos" },
      { id: "locais", label: "Locais" },
    ],
  },
  {
    id: "sofia",
    label: "SOFIA",
    icon: "✦",
    color: palette.sofiaAccent,
    children: [
      { id: "chat", label: "Chat / Playground" },
      { id: "memoria", label: "Memória RAG" },
      { id: "prompt", label: "Prompt Principal" },
      { id: "conversas", label: "Conversas & Handoffs" },
    ],
  },
  {
    id: "administracao",
    label: "ADMINISTRAÇÃO",
    icon: "◧",
    children: [
      { id: "usuarios", label: "Usuários & Permissões" },
      { id: "conectores", label: "Conectores/Integrações" },
      { id: "backup", label: "Backup & Exportação" },
      { id: "configuracoes", label: "Configurações & Auditoria" },
    ],
  },
];

function MiniChart({ color, data }: { color: string; data: number[] }) {
  const max = Math.max(...data);
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * 80 + 10},${30 - (v / max) * 20}`)
    .join(" ");
  const area =
    `M10,30 ` +
    data
      .map((v, i) => `L${(i / (data.length - 1)) * 80 + 10},${30 - (v / max) * 20}`)
      .join(" ") +
    ` L90,30 Z`;
  return (
    <svg width="90" height="32" viewBox="0 0 100 32">
      <path d={area} fill={color} opacity="0.15" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

function BarChart({
  data,
  color,
}: {
  data: { label: string; value: number }[];
  color: string;
}) {
  const max = Math.max(...data.map((d) => d.value));
  return (
    <div className="flex flex-col gap-2">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-2">
          <span
            style={{ fontSize: 11, color: palette.textGray, width: 80, textAlign: "right" }}
          >
            {d.label}
          </span>
          <div
            style={{
              height: 10,
              width: `${(d.value / max) * 140}px`,
              background: color,
              borderRadius: 4,
              opacity: 0.8,
            }}
          />
          <span style={{ fontSize: 11, color: palette.deepBlue }}>{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function AreaChart() {
  const pts = [12, 18, 14, 22, 28, 35, 42, 38, 45, 50, 44, 52, 48];
  const max = Math.max(...pts);
  const w = 440;
  const h = 100;
  const points = pts.map((v, i) => ({
    x: (i / (pts.length - 1)) * (w - 40) + 20,
    y: h - 20 - (v / max) * (h - 30),
  }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const area = `${path} L${points[points.length - 1].x},${h - 20} L${points[0].x},${h - 20} Z`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.agua} stopOpacity="0.35" />
          <stop offset="100%" stopColor={palette.agua} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#areaGrad)" />
      <path d={path} fill="none" stroke={palette.agua} strokeWidth="2" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={i === 10 ? 4 : 2} fill={palette.agua} />
      ))}
    </svg>
  );
}

function FunnelBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          color: palette.textGray,
          marginBottom: 4,
        }}
      >
        <span>{label}</span>
        <span style={{ color: palette.deepBlue, fontWeight: 600 }}>{value}</span>
      </div>
      <div
        style={{
          height: 8,
          background: palette.mistBlue,
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${(value / total) * 100}%`,
            background: color,
            borderRadius: 4,
          }}
        />
      </div>
    </div>
  );
}

function ChatBubble({
  role,
  text,
}: {
  role: "user" | "sofia";
  text: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: role === "user" ? "flex-end" : "flex-start",
        marginBottom: 12,
      }}
    >
      {role === "sofia" && (
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${palette.sofiaBg}, ${palette.skyBlue})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            marginRight: 8,
            flexShrink: 0,
          }}
        >
          ✦
        </div>
      )}
      <div
        style={{
          maxWidth: "72%",
          padding: "10px 14px",
          borderRadius: role === "sofia" ? "4px 16px 16px 16px" : "16px 4px 16px 16px",
          background:
            role === "sofia"
              ? `linear-gradient(135deg, ${palette.sofiaBg}, #EBF4FA)`
              : `linear-gradient(135deg, ${palette.instBlue}, #4a68a0)`,
          color: role === "sofia" ? palette.deepBlue : "#fff",
          fontSize: 13,
          lineHeight: 1.5,
          boxShadow: "0 2px 8px rgba(31,52,77,0.08)",
        }}
      >
        {text}
      </div>
    </div>
  );
}

const kpis = [
  {
    label: "FATURAMENTO",
    value: "R$ 87.420",
    delta: "+18,4%",
    up: true,
    data: [40, 55, 48, 62, 58, 72, 80, 75, 87],
    color: palette.instBlue,
  },
  {
    label: "MATRÍCULAS ATIVAS",
    value: "142",
    delta: "+12 este mês",
    up: true,
    data: [80, 90, 88, 100, 110, 120, 118, 130, 142],
    color: palette.agua,
  },
  {
    label: "VENDAS DA LOJA",
    value: "R$ 34.800",
    delta: "+9,2%",
    up: true,
    data: [20, 28, 24, 32, 30, 36, 34, 38, 35],
    color: palette.store,
  },
  {
    label: "INADIMPLÊNCIA",
    value: "3,1%",
    delta: "-0,4%",
    up: false,
    data: [5, 4.8, 4.2, 4.5, 3.8, 3.5, 3.2, 3.0, 3.1],
    color: palette.fogo,
  },
  {
    label: "LEADS NO PIPELINE",
    value: "217",
    delta: "+34 novos",
    up: true,
    data: [120, 140, 150, 165, 172, 188, 195, 210, 217],
    color: palette.ar,
  },
  {
    label: "ATENDIMENTOS SOFIA",
    value: "1.043",
    delta: "Tempo médio 3,2min",
    up: true,
    data: [400, 520, 600, 680, 750, 820, 900, 980, 1043],
    color: palette.sofiaAccent,
  },
];

const productCategories = [
  { label: "Tibetanos", value: 98 },
  { label: "Cristais", value: 74 },
  { label: "Kalimba", value: 61 },
  { label: "Shaker", value: 45 },
  { label: "Percussão", value: 38 },
];

const alerts = [
  { icon: "⚠", text: "3 produtos com estoque crítico", color: palette.ar },
  { icon: "📋", text: "7 contratos pendentes de assinatura", color: palette.instBlue },
  { icon: "🎓", text: "12 certificados aguardando emissão", color: palette.agua },
  { icon: "💬", text: "4 leads aguardando handoff da Sofia", color: palette.sofiaAccent },
];

const finMetrics = [
  { label: "FAT. SEM FRETE", value: "R$ 14.806", delta: "+56,87%" },
  { label: "PREÇO DE CUSTO", value: "R$ 7.648", delta: "+58,20%" },
  { label: "MARKUP", value: "46,98%", delta: "+3,71%" },
  { label: "IMPOSTOS (10,64%)", value: "R$ 1.575", delta: "+57,72%" },
  { label: "TAXA VENDA (28,37%)", value: "R$ 1.903", delta: "+56,43%" },
  { label: "LUCRO (6,69%)", value: "R$ 1.472", delta: "+43,47%" },
];

const courses = [
  {
    name: "Ciclo Água",
    element: "agua",
    color: palette.agua,
    modality: "Presencial",
    students: 28,
    capacity: 30,
    next: "14 Ago",
  },
  {
    name: "Ciclo Fogo",
    element: "fogo",
    color: palette.fogo,
    modality: "Presencial",
    students: 22,
    capacity: 25,
    next: "02 Set",
  },
  {
    name: "Ciclo Terra",
    element: "terra",
    color: palette.terra,
    modality: "Presencial",
    students: 18,
    capacity: 20,
    next: "20 Set",
  },
  {
    name: "Taquetina — Ciclo Ar",
    element: "ar",
    color: palette.ar,
    modality: "Online",
    students: 47,
    capacity: 60,
    next: "Contínuo",
  },
  {
    name: "Sound Healing",
    element: "agua",
    color: palette.agua,
    modality: "Presencial",
    students: 15,
    capacity: 16,
    next: "10 Out",
  },
];

const students = [
  { name: "Ana Carvalho", cpf: "***.***.***-12", email: "ana@email.com", course: "Ciclo Água", status: "Pago", contract: "Assinado" },
  { name: "Marcelo Diniz", cpf: "***.***.***-45", email: "marcelo@email.com", course: "Taquetina — Ar", status: "Pago", contract: "Pendente" },
  { name: "Fernanda Lima", cpf: "***.***.***-78", email: "fernanda@email.com", course: "Ciclo Fogo", status: "Parcial", contract: "Assinado" },
  { name: "Ricardo Matos", cpf: "***.***.***-90", email: "rm@email.com", course: "Ciclo Terra", status: "Em atraso", contract: "Assinado" },
  { name: "Sofia Martins", cpf: "***.***.***-33", email: "sofia@email.com", course: "Sound Healing", status: "Pago", contract: "Assinado" },
];

const orders = [
  { id: "#4821", customer: "João Pereira", product: "Cuia Tibetana 25cm", status: "Verificado", value: "R$ 480", date: "08 Jul" },
  { id: "#4820", customer: "Paula Costa", product: "Kit Cristais de Quartzo", status: "Em andamento", value: "R$ 320", date: "08 Jul" },
  { id: "#4819", customer: "Bruno Alves", product: "Kalimba 17 teclas", status: "Em aberto", value: "R$ 210", date: "07 Jul" },
  { id: "#4818", customer: "Carla Moura", product: "Shaker Gourd Natural", status: "Cancelado", value: "R$ 95", date: "07 Jul" },
  { id: "#4817", customer: "Luiz Gomes", product: "Cuia Tibetana 30cm", status: "Verificado", value: "R$ 620", date: "06 Jul" },
];

const knowledgeItems = [
  { title: "PROMPT - Sofia (Sistema Completo) v1.0", type: "PDF", tags: "identidade, sofia", status: "Indexado", date: "01 Jul" },
  { title: "Catálogo de Cursos 2026", type: "PDF", tags: "cursos, educação", status: "Indexado", date: "03 Jul" },
  { title: "FAQ Instrumentos Soundfulness", type: "Doc", tags: "store, FAQ", status: "Indexado", date: "05 Jul" },
  { title: "Política de Pagamentos e Bolsas", type: "Link", tags: "financeiro, contrato", status: "Pendente", date: "08 Jul" },
  { title: "Apostila Ciclo Água — Capítulo 1-4", type: "PDF", tags: "agua, conteúdo", status: "Indexado", date: "02 Jul" },
];

const connectors = [
  { name: "OMIE", desc: "ERP / Financeiro", status: "mock", color: palette.ar },
  { name: "Kommo", desc: "CRM / Pipeline", status: "mock", color: palette.ar },
  { name: "Wix Store", desc: "E-commerce", status: "mock", color: palette.ar },
  { name: "Superagentes", desc: "Sofia em produção", status: "desconectado", color: palette.textGray },
];

const calEvents = [
  { date: "14 Ago", label: "Ciclo Água — Turma 2026-B", color: palette.agua, local: "São Paulo / SP" },
  { date: "27 Jul–12 Ago", label: "Indisponibilidade — França", color: palette.textGray, local: "Internacional" },
  { date: "02 Set", label: "Ciclo Fogo — Turma 2026-A", color: palette.fogo, local: "Rio de Janeiro / RJ" },
  { date: "20 Set", label: "Ciclo Terra — Ritual de Cacau", color: palette.terra, local: "Campos do Jordão / SP" },
  { date: "05–14 Out", label: "Indisponibilidade — Campos do Jordão", color: palette.textGray, local: "Interior SP" },
  { date: "10 Out", label: "Sound Healing — Intensivo", color: palette.agua, local: "São Paulo / SP" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h2
        style={{
          fontFamily: "Montserrat, sans-serif",
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: palette.instBlue,
          marginBottom: 16,
          paddingBottom: 8,
          borderBottom: `1px solid ${palette.mistBlue}`,
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 20,
        boxShadow: "0 4px 20px rgba(31,52,77,0.07)",
        padding: "20px 24px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "3px 10px",
        borderRadius: 999,
        background: color + "20",
        color,
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    Pago: palette.terra,
    Parcial: palette.ar,
    "Em atraso": palette.fogo,
    Assinado: palette.agua,
    Pendente: palette.ar,
    Verificado: palette.terra,
    "Em andamento": palette.instBlue,
    "Em aberto": palette.ar,
    Cancelado: palette.fogo,
    Indexado: palette.agua,
    desconectado: palette.textGray,
    mock: palette.ar,
    conectado: palette.terra,
    Planejada: palette.textGray,
    Aberta: palette.instBlue,
  };
  return <Badge label={status} color={map[status] || palette.textGray} />;
}

// ───────── Views ─────────

function DashboardView() {
  return (
    <div>
      {/* KPI Cards */}
      <Section title="Indicadores do Período">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 20 }}>
          {kpis.map((k) => (
            <Card key={k.label} style={{ padding: "16px 20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      fontFamily: "Montserrat, sans-serif",
                      fontWeight: 600,
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      color: palette.textGray,
                      marginBottom: 6,
                    }}
                  >
                    {k.label}
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: palette.deepBlue,
                      fontFamily: "Montserrat, sans-serif",
                    }}
                  >
                    {k.value}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: k.up ? palette.terra : palette.fogo,
                      marginTop: 3,
                    }}
                  >
                    {k.up ? "↑" : "↓"} {k.delta}
                  </div>
                </div>
                <MiniChart color={k.color} data={k.data} />
              </div>
            </Card>
          ))}
        </div>
      </Section>

      {/* Charts row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        <Card>
          <div
            style={{
              fontSize: 11,
              fontFamily: "Montserrat, sans-serif",
              fontWeight: 600,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: palette.textGray,
              marginBottom: 14,
            }}
          >
            Valor total de pedidos por dia
          </div>
          <AreaChart />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            {[
              { label: "Cancelado", color: palette.fogo },
              { label: "Em aberto", color: palette.ar },
              { label: "Em andamento", color: palette.instBlue },
              { label: "Verificado", color: palette.terra },
            ].map((s) => (
              <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: s.color }} />
                <span style={{ fontSize: 10, color: palette.textGray }}>{s.label}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <div
            style={{
              fontSize: 11,
              fontFamily: "Montserrat, sans-serif",
              fontWeight: 600,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: palette.textGray,
              marginBottom: 14,
            }}
          >
            Produtos por categoria
          </div>
          <BarChart data={productCategories} color={palette.store} />
        </Card>
      </div>

      {/* Financial metrics strip */}
      <Card style={{ marginBottom: 20, padding: "16px 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 0 }}>
          {finMetrics.map((m, i) => (
            <div
              key={m.label}
              style={{
                textAlign: "center",
                padding: "0 12px",
                borderRight: i < finMetrics.length - 1 ? `1px solid ${palette.mistBlue}` : "none",
              }}
            >
              <div style={{ fontSize: 11, color: palette.textGray, letterSpacing: "0.08em", marginBottom: 4 }}>
                {m.label}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: palette.deepBlue, fontFamily: "Montserrat, sans-serif" }}>
                {m.value}
              </div>
              <div style={{ fontSize: 11, color: palette.terra }}>{m.delta}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Alerts */}
      <Section title="Ações Pendentes">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
          {alerts.map((a) => (
            <Card
              key={a.text}
              style={{
                padding: "12px 18px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                borderLeft: `3px solid ${a.color}`,
                borderRadius: 12,
              }}
            >
              <span style={{ fontSize: 18 }}>{a.icon}</span>
              <span style={{ fontSize: 13, color: palette.deepBlue }}>{a.text}</span>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}

function FinanceiroView() {
  return (
    <div>
      <div
        style={{
          background: palette.mistBlue,
          borderRadius: 12,
          padding: "10px 16px",
          marginBottom: 20,
          fontSize: 12,
          color: palette.instBlue,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>◉</span>
        <span>
          <strong>Fonte: OMIE</strong> · Dados sincronizados em modo mock · Última sync: hoje 09:14
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 20 }}>
        {[
          { label: "Receita Total (mês)", value: "R$ 87.420", sub: "Escola + Loja + Eventos" },
          { label: "Contas a Receber", value: "R$ 23.800", sub: "38 registros pendentes" },
          { label: "Inadimplência", value: "R$ 2.710", sub: "3,1% do faturamento" },
        ].map((c) => (
          <Card key={c.label} style={{ padding: "18px 20px" }}>
            <div style={{ fontSize: 10, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: palette.textGray, marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: palette.deepBlue, fontFamily: "Montserrat, sans-serif" }}>{c.value}</div>
            <div style={{ fontSize: 11, color: palette.textGray, marginTop: 3 }}>{c.sub}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card>
          <div style={{ fontSize: 11, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: palette.textGray, marginBottom: 14 }}>
            Receita por Vertical
          </div>
          {[
            { label: "Education", value: 52420, total: 87420, color: palette.agua },
            { label: "Loja / Store", value: 28800, total: 87420, color: palette.store },
            { label: "Eventos", value: 6200, total: 87420, color: palette.sofiaAccent },
          ].map((r) => (
            <FunnelBar key={r.label} label={r.label} value={r.value} total={r.total} color={r.color} />
          ))}
        </Card>

        <Card>
          <div style={{ fontSize: 11, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: palette.textGray, marginBottom: 14 }}>
            Meta Contratual (+35% vs. média mai/26)
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: palette.textGray, marginBottom: 4 }}>
              <span>Progresso atual</span>
              <span style={{ color: palette.deepBlue, fontWeight: 600 }}>+18,4%</span>
            </div>
            <div style={{ height: 12, background: palette.mistBlue, borderRadius: 6, overflow: "hidden" }}>
              <div style={{ height: "100%", width: "52%", background: `linear-gradient(90deg, ${palette.agua}, ${palette.instBlue})`, borderRadius: 6 }} />
            </div>
            <div style={{ fontSize: 11, color: palette.textGray, marginTop: 4 }}>52% da meta atingida — R$ 87.420 de R$ 168.000 projetado</div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <div style={{ flex: 1, textAlign: "center", padding: 12, background: palette.warmWhite, borderRadius: 12 }}>
              <div style={{ fontSize: 10, color: palette.textGray, letterSpacing: "0.12em", textTransform: "uppercase" }}>Média Ref. (mai/26)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: palette.deepBlue, fontFamily: "Montserrat, sans-serif", marginTop: 4 }}>R$ 73.786</div>
            </div>
            <div style={{ flex: 1, textAlign: "center", padding: 12, background: palette.warmWhite, borderRadius: 12 }}>
              <div style={{ fontSize: 10, color: palette.textGray, letterSpacing: "0.12em", textTransform: "uppercase" }}>Meta (+35%)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: palette.instBlue, fontFamily: "Montserrat, sans-serif", marginTop: 4 }}>R$ 99.611</div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ComercialView() {
  return (
    <div>
      <div
        style={{
          background: `${palette.sofiaBg}`,
          borderRadius: 12,
          padding: "10px 16px",
          marginBottom: 20,
          fontSize: 12,
          color: palette.instBlue,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>◉</span>
        <span>
          <strong>Fonte: Kommo + Sofia</strong> · Visão comercial separada do financeiro
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        {[
          { label: "LEADS TOTAL", value: "217", color: palette.instBlue },
          { label: "QUALIFICADOS", value: "58", color: palette.agua },
          { label: "TEMPO MÉDIO 1º CONTATO", value: "3,2min", color: palette.terra },
          { label: "TICKET MÉDIO", value: "R$ 2.840", color: palette.sofiaAccent },
        ].map((k) => (
          <Card key={k.label} style={{ padding: "14px 16px", textAlign: "center" }}>
            <div style={{ fontSize: 9, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: palette.textGray, marginBottom: 6 }}>{k.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: k.color, fontFamily: "Montserrat, sans-serif" }}>{k.value}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card>
          <div style={{ fontSize: 11, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: palette.textGray, marginBottom: 14 }}>Pipeline por Curso</div>
          {[
            { label: "Ciclo Água", value: 64, total: 217, color: palette.agua },
            { label: "Ciclo Fogo", value: 48, total: 217, color: palette.fogo },
            { label: "Ciclo Terra", value: 39, total: 217, color: palette.terra },
            { label: "Taquetina — Ar", value: 66, total: 217, color: palette.ar },
          ].map((f) => (
            <FunnelBar key={f.label} label={f.label} value={f.value} total={f.total} color={f.color} />
          ))}
        </Card>

        <Card>
          <div style={{ fontSize: 11, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: palette.textGray, marginBottom: 14 }}>Estágios do Funil (Kommo)</div>
          {[
            { label: "Novos leads", value: 72, color: palette.textGray },
            { label: "Contato feito", value: 58, color: palette.instBlue },
            { label: "Interesse confirmado", value: 44, color: palette.agua },
            { label: "Proposta enviada", value: 28, color: palette.sofiaAccent },
            { label: "Matrícula fechada", value: 15, color: palette.terra },
          ].map((s) => (
            <FunnelBar key={s.label} label={s.label} value={s.value} total={72} color={s.color} />
          ))}
        </Card>
      </div>
    </div>
  );
}

function CalendarioView() {
  return (
    <div>
      <Section title="Próximos Eventos & Turmas">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {calEvents.map((e) => (
            <Card
              key={e.label}
              style={{
                padding: "14px 20px",
                display: "flex",
                alignItems: "center",
                gap: 16,
                borderLeft: `4px solid ${e.color}`,
                borderRadius: 14,
              }}
            >
              <div style={{ minWidth: 100 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: e.color, fontFamily: "Montserrat, sans-serif" }}>{e.date}</div>
                <div style={{ fontSize: 10, color: palette.textGray, marginTop: 2 }}>{e.local}</div>
              </div>
              <div style={{ fontSize: 14, color: palette.deepBlue }}>{e.label}</div>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}

function PainelLojaView() {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        {[
          { label: "GMV DO PERÍODO", value: "R$ 34.800", sub: "Gross Merchandise Value" },
          { label: "TICKET MÉDIO", value: "R$ 348", sub: "100 pedidos no mês" },
          { label: "SELL-THROUGH", value: "84,2%", sub: "do estoque disponível" },
          { label: "CARRINHOS ABAND.", value: "23", sub: "R$ 4.120 em risco" },
        ].map((k) => (
          <Card key={k.label} style={{ padding: "16px 18px" }}>
            <div style={{ fontSize: 9, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: palette.textGray, marginBottom: 6 }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: palette.deepBlue, fontFamily: "Montserrat, sans-serif" }}>{k.value}</div>
            <div style={{ fontSize: 11, color: palette.textGray, marginTop: 3 }}>{k.sub}</div>
          </Card>
        ))}
      </div>

      <Section title="Pedidos Recentes">
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: palette.warmWhite }}>
                {["Pedido", "Cliente", "Produto", "Status", "Valor", "Data"].map((h) => (
                  <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 10, fontFamily: "Montserrat, sans-serif", letterSpacing: "0.12em", textTransform: "uppercase", color: palette.textGray, fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o, i) => (
                <tr key={o.id} style={{ borderTop: `1px solid ${palette.mistBlue}`, background: i % 2 === 0 ? "#fff" : palette.warmWhite + "60" }}>
                  <td style={{ padding: "10px 16px", fontSize: 13, color: palette.instBlue, fontWeight: 600 }}>{o.id}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13, color: palette.deepBlue }}>{o.customer}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13, color: palette.textGray }}>{o.product}</td>
                  <td style={{ padding: "10px 16px" }}><StatusBadge status={o.status} /></td>
                  <td style={{ padding: "10px 16px", fontSize: 13, fontWeight: 600, color: palette.deepBlue }}>{o.value}</td>
                  <td style={{ padding: "10px 16px", fontSize: 12, color: palette.textGray }}>{o.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Section>
    </div>
  );
}

function PainelEscolaView() {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        {[
          { label: "MATRÍCULAS ATIVAS", value: "142", sub: "em 5 cursos" },
          { label: "CONTRATOS EMITIDOS", value: "138/142", sub: "4 pendentes de assinatura" },
          { label: "CERTIFICADOS PEND.", value: "12", sub: "aguardando emissão" },
          { label: "OCUPAÇÃO MÉDIA", value: "87%", sub: "das vagas disponíveis" },
        ].map((k) => (
          <Card key={k.label} style={{ padding: "16px 18px" }}>
            <div style={{ fontSize: 9, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: palette.textGray, marginBottom: 6 }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: palette.deepBlue, fontFamily: "Montserrat, sans-serif" }}>{k.value}</div>
            <div style={{ fontSize: 11, color: palette.textGray, marginTop: 3 }}>{k.sub}</div>
          </Card>
        ))}
      </div>

      <Section title="Cursos & Turmas">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {courses.map((c) => (
            <Card key={c.name} style={{ padding: "14px 20px", borderLeft: `4px solid ${c.color}`, borderRadius: 14, display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: palette.deepBlue, marginBottom: 2 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: palette.textGray }}>{c.modality} · Próxima turma: {c.next}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, color: palette.textGray }}>Vagas</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: c.color }}>{c.students}/{c.capacity}</div>
              </div>
              <div style={{ width: 60 }}>
                <div style={{ height: 8, background: palette.mistBlue, borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(c.students / c.capacity) * 100}%`, background: c.color, borderRadius: 4 }} />
                </div>
                <div style={{ fontSize: 10, color: palette.textGray, marginTop: 2, textAlign: "right" }}>{Math.round((c.students / c.capacity) * 100)}%</div>
              </div>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Alunos Recentes">
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: palette.warmWhite }}>
                {["Nome", "Curso", "Pagamento", "Contrato"].map((h) => (
                  <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 10, fontFamily: "Montserrat, sans-serif", letterSpacing: "0.12em", textTransform: "uppercase", color: palette.textGray, fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {students.map((s, i) => (
                <tr key={s.name} style={{ borderTop: `1px solid ${palette.mistBlue}`, background: i % 2 === 0 ? "#fff" : palette.warmWhite + "60" }}>
                  <td style={{ padding: "10px 16px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: palette.deepBlue }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: palette.textGray }}>{s.email}</div>
                  </td>
                  <td style={{ padding: "10px 16px", fontSize: 13, color: palette.textGray }}>{s.course}</td>
                  <td style={{ padding: "10px 16px" }}><StatusBadge status={s.status} /></td>
                  <td style={{ padding: "10px 16px" }}><StatusBadge status={s.contract} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Section>
    </div>
  );
}

function SofiaChat() {
  const msgs = [
    { role: "user" as const, text: "Sofia, quantas matrículas temos abertas no Ciclo Água este semestre?" },
    { role: "sofia" as const, text: "Olá! Com base nos dados de Education, temos 28 alunos matriculados na turma Ciclo Água 2026-B, que começa em 14 de agosto em São Paulo. A turma tem capacidade para 30 alunos, então ainda restam 2 vagas disponíveis. Posso verificar a situação de pagamento de cada matrícula se precisar." },
    { role: "user" as const, text: "Quais alunos ainda não assinaram o contrato?" },
    { role: "sofia" as const, text: "Identifico 4 matrículas com contrato pendente de assinatura na turma Ciclo Água 2026-B. Devo enviar um lembrete automático pelo WhatsApp para esses alunos? Posso também gerar uma lista completa para revisão manual." },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px",
          background: `linear-gradient(180deg, ${palette.sofiaBg}40 0%, #fff 100%)`,
          borderRadius: 16,
          marginBottom: 12,
          minHeight: 260,
        }}
      >
        {msgs.map((m, i) => (
          <ChatBubble key={i} role={m.role} text={m.text} />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "10px 14px",
          background: "#fff",
          borderRadius: 16,
          border: `1px solid ${palette.skyBlue}`,
          boxShadow: "0 2px 12px rgba(31,52,77,0.06)",
        }}
      >
        <input
          placeholder="Pergunte à Sofia..."
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            fontSize: 13,
            color: palette.deepBlue,
            background: "transparent",
            fontFamily: "inherit",
          }}
        />
        <button
          style={{
            background: `linear-gradient(135deg, ${palette.instBlue}, ${palette.deepBlue})`,
            color: "#fff",
            border: "none",
            borderRadius: 12,
            padding: "8px 16px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "Montserrat, sans-serif",
            letterSpacing: "0.06em",
          }}
        >
          Enviar
        </button>
      </div>
    </div>
  );
}

function SofiaView() {
  const [tab, setTab] = useState<"chat" | "memoria" | "prompt" | "conversas">("chat");
  const tabs = [
    { id: "chat" as const, label: "Chat / Playground" },
    { id: "memoria" as const, label: "Memória RAG" },
    { id: "prompt" as const, label: "Prompt Principal" },
    { id: "conversas" as const, label: "Conversas & Handoffs" },
  ];
  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 20,
          background: palette.sofiaBg + "60",
          padding: 4,
          borderRadius: 14,
          width: "fit-content",
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: "8px 16px",
              borderRadius: 10,
              border: "none",
              background: tab === t.id ? "#fff" : "transparent",
              color: tab === t.id ? palette.deepBlue : palette.textGray,
              fontSize: 12,
              fontWeight: tab === t.id ? 600 : 400,
              cursor: "pointer",
              fontFamily: "Montserrat, sans-serif",
              letterSpacing: "0.04em",
              boxShadow: tab === t.id ? "0 2px 8px rgba(31,52,77,0.1)" : "none",
              transition: "all 0.2s",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "chat" && <SofiaChat />}

      {tab === "memoria" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: palette.textGray }}>{knowledgeItems.length} documentos indexados · 2,4 GB · 18.430 chunks</div>
            <button
              style={{
                background: palette.instBlue,
                color: "#fff",
                border: "none",
                borderRadius: 999,
                padding: "8px 20px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "Montserrat, sans-serif",
                letterSpacing: "0.06em",
              }}
            >
              + Adicionar documento
            </button>
          </div>
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: palette.warmWhite }}>
                  {["Título", "Tipo", "Tags", "Status", "Data"].map((h) => (
                    <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 10, fontFamily: "Montserrat, sans-serif", letterSpacing: "0.12em", textTransform: "uppercase", color: palette.textGray, fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {knowledgeItems.map((k, i) => (
                  <tr key={k.title} style={{ borderTop: `1px solid ${palette.mistBlue}`, background: i % 2 === 0 ? "#fff" : palette.warmWhite + "60" }}>
                    <td style={{ padding: "10px 16px", fontSize: 13, color: palette.deepBlue, fontWeight: 500 }}>{k.title}</td>
                    <td style={{ padding: "10px 16px" }}><Badge label={k.type} color={palette.instBlue} /></td>
                    <td style={{ padding: "10px 16px", fontSize: 12, color: palette.textGray }}>{k.tags}</td>
                    <td style={{ padding: "10px 16px" }}><StatusBadge status={k.status} /></td>
                    <td style={{ padding: "10px 16px", fontSize: 12, color: palette.textGray }}>{k.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {tab === "prompt" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 16 }}>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: palette.deepBlue }}>Prompt Principal — v1.3</div>
                <div style={{ fontSize: 11, color: palette.terra }}>● Versão ativa</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ padding: "6px 14px", borderRadius: 999, border: `1px solid ${palette.instBlue}`, background: "transparent", color: palette.instBlue, fontSize: 12, cursor: "pointer" }}>Salvar nova versão</button>
                <button style={{ padding: "6px 14px", borderRadius: 999, border: "none", background: palette.instBlue, color: "#fff", fontSize: 12, cursor: "pointer" }}>Testar no playground</button>
              </div>
            </div>
            <textarea
              defaultValue={`# Identidade
Você é Sofia, a assistente inteligente da Soundfulness — uma escola de som, cura e transformação baseada no Brasil.

# Missão
Seu papel é acolher, orientar e conectar pessoas aos cursos, instrumentos e vivências da Soundfulness com presença, clareza e calor humano.

# Princípios de conduta
- Fale com suavidade e presença, como alguém que realmente escuta.
- Nunca pressione ou use linguagem de urgência agressiva.
- Quando em dúvida, pergunte — não assuma.
- Encaminhe ao time humano quando a conversa exigir julgamento sensível.

# Guardrails
- Não compartilhe preços sem confirmar com a base de conhecimento atualizada.
- Não prometa datas de turmas sem verificar o calendário.
- Nunca mencione concorrentes.`}
              style={{
                width: "100%",
                height: 280,
                padding: 16,
                border: `1px solid ${palette.skyBlue}`,
                borderRadius: 12,
                fontFamily: "monospace",
                fontSize: 12,
                color: palette.deepBlue,
                lineHeight: 1.6,
                resize: "vertical",
                background: palette.warmWhite,
                boxSizing: "border-box",
              }}
            />
          </Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Card>
              <div style={{ fontSize: 11, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: palette.textGray, marginBottom: 12 }}>Histórico de Versões</div>
              {[
                { v: "v1.3", date: "08 Jul", active: true },
                { v: "v1.2", date: "02 Jul", active: false },
                { v: "v1.1", date: "20 Jun", active: false },
                { v: "v1.0", date: "01 Jun", active: false },
              ].map((ver) => (
                <div key={ver.v} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${palette.mistBlue}` }}>
                  <span style={{ fontSize: 13, fontWeight: ver.active ? 700 : 400, color: ver.active ? palette.instBlue : palette.deepBlue }}>{ver.v}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: palette.textGray }}>{ver.date}</span>
                    {ver.active && <Badge label="ativa" color={palette.terra} />}
                  </div>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}

      {tab === "conversas" && (
        <Card>
          <div style={{ fontSize: 11, fontFamily: "Montserrat, sans-serif", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: palette.textGray, marginBottom: 16 }}>Log de Conversas (últimas 24h)</div>
          {[
            { contact: "Ana C.", channel: "WhatsApp", score: "Alta", handoff: false, topic: "Interesse no Ciclo Água" },
            { contact: "Lead 2814", channel: "Instagram", score: "Média", handoff: true, topic: "Dúvida sobre parcelamento" },
            { contact: "Marcos R.", channel: "Site", score: "Alta", handoff: false, topic: "Kalimba 17 teclas — disponibilidade" },
            { contact: "Lead 2813", channel: "WhatsApp", score: "Baixa", handoff: false, topic: "Pergunta geral sobre sound healing" },
          ].map((c, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 0", borderBottom: `1px solid ${palette.mistBlue}` }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: palette.sofiaBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>✦</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: palette.deepBlue }}>{c.contact}</div>
                <div style={{ fontSize: 11, color: palette.textGray }}>{c.topic}</div>
              </div>
              <Badge label={c.channel} color={palette.instBlue} />
              <Badge label={`Score: ${c.score}`} color={c.score === "Alta" ? palette.terra : c.score === "Média" ? palette.ar : palette.textGray} />
              {c.handoff && <Badge label="Handoff" color={palette.fogo} />}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function AdminView() {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <Section title="Usuários & Permissões">
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: palette.warmWhite }}>
                  {["Nome", "Papel", "Último acesso"].map((h) => (
                    <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontFamily: "Montserrat, sans-serif", letterSpacing: "0.12em", textTransform: "uppercase", color: palette.textGray, fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { name: "Pierre Oliveira", role: "Owner", last: "Hoje 09:14" },
                  { name: "Juliana Ferreira", role: "Financeiro", last: "Hoje 08:45" },
                  { name: "Luiz Gustavo", role: "Comercial", last: "Ontem 18:30" },
                  { name: "Lilian Santos", role: "Conteúdo", last: "Hoje 07:22" },
                  { name: "Luciano TI", role: "TI", last: "Hoje 09:00" },
                ].map((u, i) => (
                  <tr key={u.name} style={{ borderTop: `1px solid ${palette.mistBlue}` }}>
                    <td style={{ padding: "10px 14px", fontSize: 13, color: palette.deepBlue, fontWeight: 500 }}>{u.name}</td>
                    <td style={{ padding: "10px 14px" }}><Badge label={u.role} color={palette.instBlue} /></td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: palette.textGray }}>{u.last}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </Section>

        <Section title="Conectores / Integrações">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {connectors.map((c) => (
              <Card key={c.name} style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, borderRadius: 14 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: palette.deepBlue }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: palette.textGray }}>{c.desc}</div>
                </div>
                <StatusBadge status={c.status} />
                <button style={{ padding: "6px 12px", borderRadius: 999, border: `1px solid ${palette.instBlue}`, background: "transparent", color: palette.instBlue, fontSize: 11, cursor: "pointer" }}>Testar</button>
              </Card>
            ))}
          </div>
          <div style={{ marginTop: 12, padding: "10px 14px", background: palette.warmWhite, borderRadius: 12, fontSize: 11, color: palette.textGray }}>
            USE_MOCK_DATA=true · Configure as credenciais para ativar cada conector em produção.
          </div>
        </Section>
      </div>

      <Section title="Backup & Exportação">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {[
            { label: "Backup do banco", icon: "💾", action: "Baixar dump", desc: "Último: hoje 03:00" },
            { label: "Exportar alunos", icon: "🎓", action: "Exportar CSV", desc: "142 registros" },
            { label: "Exportar leads", icon: "📊", action: "Exportar CSV", desc: "217 registros" },
          ].map((b) => (
            <Card key={b.label} style={{ padding: "18px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>{b.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: palette.deepBlue, marginBottom: 4 }}>{b.label}</div>
              <div style={{ fontSize: 11, color: palette.textGray, marginBottom: 12 }}>{b.desc}</div>
              <button style={{ padding: "8px 16px", borderRadius: 999, border: "none", background: palette.instBlue, color: "#fff", fontSize: 11, cursor: "pointer", fontFamily: "Montserrat, sans-serif", letterSpacing: "0.06em" }}>{b.action}</button>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}

export function SoundOS() {
  const [activeGroup, setActiveGroup] = useState("visao-geral");
  const [activeItem, setActiveItem] = useState("dashboard");
  const [expandedGroups, setExpandedGroups] = useState<string[]>(["visao-geral"]);

  function toggleGroup(id: string) {
    setExpandedGroups((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]
    );
  }

  function getView() {
    switch (activeItem) {
      case "dashboard": return <DashboardView />;
      case "financeiro": return <FinanceiroView />;
      case "comercial": return <ComercialView />;
      case "calendario": return <CalendarioView />;
      case "painel-loja":
      case "pedidos":
      case "produtos":
      case "clientes-store":
      case "revendedores":
        return <PainelLojaView />;
      case "painel-escola":
      case "cursos":
      case "turmas":
      case "alunos":
      case "matriculas":
      case "locais":
        return <PainelEscolaView />;
      case "chat":
      case "memoria":
      case "prompt":
      case "conversas":
        return <SofiaView />;
      case "usuarios":
      case "conectores":
      case "backup":
      case "configuracoes":
        return <AdminView />;
      default: return <DashboardView />;
    }
  }

  const activeNav = navItems.find((n) => n.children?.some((c) => c.id === activeItem));
  const activeChild = activeNav?.children?.find((c) => c.id === activeItem);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        fontFamily: "Lato, Nunito Sans, sans-serif",
        background: palette.warmWhite,
        overflow: "hidden",
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          width: 220,
          background: palette.deepBlue,
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          boxShadow: "2px 0 20px rgba(31,52,77,0.15)",
        }}
      >
        {/* Logo */}
        <div
          style={{
            padding: "22px 20px 18px",
            borderBottom: `1px solid rgba(255,255,255,0.08)`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img
              src="/__mockup/soundfulness-logo.png"
              alt="Soundfulness"
              style={{
                width: 40,
                height: 40,
                objectFit: "contain",
                flexShrink: 0,
              }}
            />
            <div>
              <div
                style={{
                  fontFamily: "Montserrat, sans-serif",
                  fontSize: 15,
                  fontWeight: 700,
                  color: "#fff",
                  letterSpacing: "0.08em",
                }}
              >
                SoundOS
              </div>
              <div style={{ fontSize: 9, color: palette.skyBlue, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                Hub de Gestão
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
          {navItems.map((group) => {
            const isExpanded = expandedGroups.includes(group.id);
            const groupColor = group.color || palette.skyBlue;
            return (
              <div key={group.id}>
                <button
                  onClick={() => {
                    toggleGroup(group.id);
                    setActiveGroup(group.id);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 18px",
                    background: activeGroup === group.id ? "rgba(255,255,255,0.08)" : "transparent",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 14, color: groupColor }}>{group.icon}</span>
                  <span
                    style={{
                      fontFamily: "Montserrat, sans-serif",
                      fontSize: 9,
                      fontWeight: 600,
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      color: activeGroup === group.id ? "#fff" : "rgba(255,255,255,0.55)",
                      flex: 1,
                    }}
                  >
                    {group.label}
                  </span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>
                    {isExpanded ? "▾" : "▸"}
                  </span>
                </button>
                {isExpanded && group.children && (
                  <div>
                    {group.children.map((child) => (
                      <button
                        key={child.id}
                        onClick={() => {
                          setActiveItem(child.id);
                          setActiveGroup(group.id);
                        }}
                        style={{
                          width: "100%",
                          display: "block",
                          padding: "7px 18px 7px 42px",
                          background: activeItem === child.id ? `${groupColor}20` : "transparent",
                          border: "none",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: 12,
                          color: activeItem === child.id ? "#fff" : "rgba(255,255,255,0.5)",
                          borderLeft: activeItem === child.id ? `2px solid ${groupColor}` : "2px solid transparent",
                          fontFamily: "Lato, sans-serif",
                          transition: "all 0.15s",
                        }}
                      >
                        {child.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* User */}
        <div
          style={{
            padding: "14px 18px",
            borderTop: `1px solid rgba(255,255,255,0.08)`,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: `linear-gradient(135deg, ${palette.instBlue}, ${palette.agua})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              color: "#fff",
              fontWeight: 700,
              fontFamily: "Montserrat, sans-serif",
              flexShrink: 0,
            }}
          >
            P
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>Pierre Oliveira</div>
            <div style={{ fontSize: 10, color: palette.skyBlue }}>Owner</div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Topbar */}
        <div
          style={{
            height: 56,
            background: "#fff",
            borderBottom: `1px solid ${palette.mistBlue}`,
            display: "flex",
            alignItems: "center",
            padding: "0 28px",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 11, color: palette.textGray, fontFamily: "Montserrat, sans-serif", letterSpacing: "0.12em" }}>
            {activeNav?.label}
          </span>
          <span style={{ color: palette.mistBlue }}>›</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: palette.deepBlue }}>
            {activeChild?.label || "Dashboard"}
          </span>
          <div style={{ flex: 1 }} />
          {/* Period selector */}
          <div
            style={{
              display: "flex",
              gap: 2,
              background: palette.warmWhite,
              padding: 3,
              borderRadius: 10,
            }}
          >
            {["Hoje", "Mês", "Trimestre"].map((p, i) => (
              <button
                key={p}
                style={{
                  padding: "5px 12px",
                  borderRadius: 8,
                  border: "none",
                  background: i === 1 ? "#fff" : "transparent",
                  color: i === 1 ? palette.deepBlue : palette.textGray,
                  fontSize: 11,
                  fontWeight: i === 1 ? 600 : 400,
                  cursor: "pointer",
                  boxShadow: i === 1 ? "0 1px 4px rgba(31,52,77,0.08)" : "none",
                  fontFamily: "Montserrat, sans-serif",
                }}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: palette.warmWhite,
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            🔔
          </button>
        </div>

        {/* Scrollable content */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "24px 28px",
          }}
        >
          {getView()}
        </div>
      </div>
    </div>
  );
}
