import { useState } from "react";
import { Link } from "wouter";
import { useListStudents } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ExternalLink, Search, Users } from "lucide-react";
import { format, parseISO } from "date-fns";
import { useLang } from "@/contexts/language";

// ── Types ────────────────────────────────────────────────────────

interface TurmaDoAluno {
  classId: number;
  classCode: string;
  courseName: string;
}

interface AlunoRow {
  id: number;
  codigo: string;
  nome: string;
  email?: string | null;
  celular?: string | null;
  cpf?: string | null;
  cidade?: string | null;
  comoFicouSabendo?: string | null;
  createdAt?: string;
  turmas: TurmaDoAluno[];
}

// ── Main page ────────────────────────────────────────────────────

export default function Alunos() {
  const { t } = useLang();
  const [busca, setBusca] = useState("");

  const { data, isLoading } = useListStudents(
    busca.trim() ? { search: busca.trim() } : undefined,
  );
  const alunos = (data ?? []) as unknown as AlunoRow[];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">
            {t("edu.alunos.title")}
          </h1>
          <p className="text-muted-foreground">
            Pessoas do CRM com matrícula em alguma turma. Alguém vira aluno ao ser
            matriculado — o cadastro em si vive na ficha da pessoa.
          </p>
        </div>
        <div className="relative w-64 shrink-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por nome…"
            className="h-9 pl-8 text-sm"
          />
        </div>
      </div>

      <Card className="shadow-sm border-border/50">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6"><Skeleton className="h-64 w-full" /></div>
          ) : alunos.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <Users className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">
                {busca.trim() ? "Nenhum aluno encontrado" : "Nenhum aluno matriculado ainda"}
              </p>
              <p className="text-xs text-muted-foreground max-w-sm">
                {busca.trim()
                  ? "Tente outro nome."
                  : "Matricule uma pessoa em uma turma na tela de Matrículas e ela aparecerá aqui."}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.nome")}</TableHead>
                  <TableHead>Turmas</TableHead>
                  <TableHead>{t("common.email")}</TableHead>
                  <TableHead>{t("common.telefone")}</TableHead>
                  <TableHead>{t("edu.alunos.cpf")}</TableHead>
                  <TableHead>{t("edu.alunos.origem")}</TableHead>
                  <TableHead>{t("edu.alunos.data_cadastro")}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {alunos.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <div className="font-medium">{a.nome}</div>
                      <div className="text-xs text-muted-foreground font-mono">{a.codigo}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {a.turmas.map((tu) => (
                          <Badge
                            key={tu.classId}
                            variant="secondary"
                            className="text-[10px] font-normal"
                            title={tu.courseName}
                          >
                            {tu.classCode}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>{a.email || "-"}</TableCell>
                    <TableCell>{a.celular || "-"}</TableCell>
                    <TableCell>{a.cpf || "-"}</TableCell>
                    <TableCell>{a.comoFicouSabendo || "-"}</TableCell>
                    <TableCell>
                      {a.createdAt ? format(parseISO(a.createdAt), "dd/MM/yyyy") : "-"}
                    </TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                        <Link href={`/pessoas/${a.id}`}>
                          Ficha <ExternalLink className="h-3 w-3 ml-1" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
