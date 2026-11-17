import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PlayCircle, Send, Users } from "lucide-react";
import { formatDateTimeBR } from "@/lib/date";
import { useListVideoEnvios } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useLang } from "@/contexts/language";

export default function VideosEnvios() {
  const { data: envios, isLoading } = useListVideoEnvios({ limit: 200 });
  const [, navigate] = useLocation();
  const { t, lang } = useLang();
  const [filtroVideo, setFiltroVideo] = useState<string | null>(null);

  const visiveis = filtroVideo ? (envios ?? []).filter(e => e.codigo === filtroVideo) : (envios ?? []);

  const porVideo = new Map<string, { titulo: string; count: number }>();
  for (const e of envios ?? []) {
    const key = e.codigo ?? e.titulo;
    const atual = porVideo.get(key);
    porVideo.set(key, { titulo: e.titulo, count: (atual?.count ?? 0) + 1 });
  }
  const topVideos = Array.from(porVideo.entries())
    .map(([codigo, v]) => ({ codigo, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("sofia.envios.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("sofia.envios.subtitle")}</p>
      </div>

      {topVideos.length > 0 && (
        <Card className="shadow-sm border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Send className="h-4 w-4 text-sofia/60" />
              {t("sofia.envios.mais_enviados")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge
              variant={filtroVideo === null ? "default" : "outline"}
              className="cursor-pointer text-xs"
              onClick={() => setFiltroVideo(null)}
            >
              {t("sofia.envios.todos")} ({envios?.length ?? 0})
            </Badge>
            {topVideos.map((v) => (
              <Badge
                key={v.codigo}
                variant={filtroVideo === v.codigo ? "default" : "outline"}
                className="cursor-pointer text-xs"
                onClick={() => setFiltroVideo(v.codigo)}
              >
                {v.titulo} ({v.count})
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="shadow-sm border-border/50">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full rounded" />)}
            </div>
          ) : visiveis.length === 0 ? (
            <div className="py-16 text-center">
              <Send className="h-10 w-10 mx-auto mb-3 text-muted-foreground/25" />
              <p className="text-muted-foreground text-sm">{t("sofia.envios.nenhum")}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs w-36">{t("sofia.mem.col_data")}</TableHead>
                  <TableHead className="text-xs">{t("sofia.videos.title")}</TableHead>
                  <TableHead className="text-xs w-32">Curso</TableHead>
                  <TableHead className="text-xs w-44">{t("common.nome")}</TableHead>
                  <TableHead className="text-xs w-24 text-right">{t("sofia.conv.conversa_prefixo")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visiveis.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTimeBR(e.createdAt)}
                    </TableCell>
                    <TableCell>
                      <a
                        href={e.link}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-sofia hover:underline"
                      >
                        <PlayCircle className="h-3.5 w-3.5 shrink-0" />
                        {e.titulo}
                      </a>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{e.curso ?? "—"}</TableCell>
                    <TableCell>
                      {e.pessoaId ? (
                        <button
                          className="inline-flex items-center gap-1.5 text-xs text-foreground hover:text-sofia hover:underline"
                          onClick={() => navigate(`/pessoas/${e.pessoaId}`)}
                        >
                          <Users className="h-3 w-3" />
                          {e.pessoaNome ?? `#${e.pessoaId}`}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        className="text-xs text-muted-foreground hover:text-sofia hover:underline"
                        onClick={() => navigate(`/sofia/conversas?conversationId=${e.conversationId}`)}
                      >
                        #{e.conversationId}
                      </button>
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
