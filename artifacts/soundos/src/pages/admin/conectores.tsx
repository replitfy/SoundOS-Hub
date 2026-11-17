import { useListConnectors } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Blocks } from "lucide-react";
import { useLang } from "@/contexts/language";

export default function Conectores() {
  const { data: connectors, isLoading } = useListConnectors();
  const { t } = useLang();

  if (isLoading) return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  if (!connectors) return null;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("admin.conectores.title")}</h1>
        <p className="text-muted-foreground">{t("admin.conectores.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {connectors.map((c) => (
          <Card key={c.id} className="shadow-sm border-border/50">
            <CardHeader className="flex flex-row items-center gap-4 pb-2">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
                <Blocks className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg font-bold">{c.name}</CardTitle>
                <div className="text-sm text-muted-foreground">{c.description}</div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex justify-between items-center mt-4">
                <div className="text-xs text-muted-foreground">{t("admin.conectores.ultima_sync")} {c.lastSync || t("common.nunca")}</div>
                <Badge variant={c.status === 'conectado' || c.status === 'mock' ? 'default' : 'outline'} className={c.status === 'conectado' ? 'bg-terra' : c.status === 'mock' ? 'bg-ar' : ''}>
                  {c.status}
                </Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
