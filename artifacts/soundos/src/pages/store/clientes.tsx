import { useListStoreCustomers } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useLang } from "@/contexts/language";

export default function Clientes() {
  const { data: customers, isLoading } = useListStoreCustomers();
  const { t, lang } = useLang();
  const numLocale = lang === "fr" ? "fr-FR" : "pt-BR";

  if (isLoading) return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  if (!customers) return null;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("store.clientes.title")}</h1>
        <p className="text-muted-foreground">{t("store.clientes.subtitle")}</p>
      </div>

      <Card className="shadow-sm border-border/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.nome")}</TableHead>
                <TableHead>{t("common.email")}</TableHead>
                <TableHead>{t("common.telefone")}</TableHead>
                <TableHead>{t("store.clientes.saldo")}</TableHead>
                <TableHead>{t("common.tipo")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.email}</TableCell>
                  <TableCell>{c.phone || '-'}</TableCell>
                  <TableCell className="font-bold text-store">R$ {c.soundsBalance.toLocaleString(numLocale)}</TableCell>
                  <TableCell>
                    {c.isStudent
                      ? <Badge className="bg-agua">{t("store.clientes.aluno")}</Badge>
                      : <Badge variant="outline">{t("store.clientes.publico")}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
