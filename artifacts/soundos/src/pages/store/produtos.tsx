import {
  exportIncompleteProducts,
  getListProductsQueryKey,
  useListProducts,
  type ListProductsParams,
  type Product,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLang } from "@/contexts/language";
import { AlertCircle, Download, ExternalLink, Eye, PackageOpen, Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDateTimeBR } from "@/lib/date";

export default function Produtos() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const pageSize = 25;
  const params: ListProductsParams = {
    search: search.trim() || undefined,
    limit: pageSize,
    offset: page * pageSize,
  };
  const { data, isLoading, isError, error } = useListProducts(
    params,
    {
      query: {
        queryKey: getListProductsQueryKey(params),
        staleTime: 5 * 60_000,
        refetchInterval: query =>
          query.state.data?.products.some(product => product.descriptionSource === "pending")
            ? 3_000
            : false,
      },
    },
  );
  const { t, lang } = useLang();
  const numLocale = lang === "fr" ? "fr-FR" : "pt-BR";

  useEffect(() => setPage(0), [search]);
  useEffect(() => {
    if (!selectedProduct) return;
    const updated = data?.products.find(product => product.id === selectedProduct.id);
    if (updated && updated.descriptionSource !== selectedProduct.descriptionSource) {
      setSelectedProduct(updated);
    }
  }, [data?.products, selectedProduct]);

  const handleExport = async () => {
    setIsExporting(true);
    setExportError(null);
    try {
      const workbook = await exportIncompleteProducts();
      const url = URL.createObjectURL(workbook);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `produtos-pendencias-wix-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : t("store.produtos.exportar_erro"));
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading) return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;

  const products = data?.products ?? [];
  const total = data?.total ?? 0;
  const lastPage = Math.max(Math.ceil(total / pageSize) - 1, 0);
  const formatPrice = (price: number | null, max: number | null, currency: string) => {
    if (price == null) return "—";
    const formatter = new Intl.NumberFormat(numLocale, { style: "currency", currency: currency || "BRL" });
    if (max != null && max !== price) return `${formatter.format(price)} – ${formatter.format(max)}`;
    return formatter.format(price);
  };
  const renderOmieInventory = (inventory: (typeof products)[number]["omieInventory"]) => {
    const quantity = inventory.quantity == null
      ? null
      : new Intl.NumberFormat(numLocale, { maximumFractionDigits: 3 }).format(inventory.quantity);
    if (inventory.status === "linked") {
      return (
        <Badge variant="outline">{quantity} {inventory.unit ?? ""} {t("store.produtos.estoque_vinculado")}</Badge>
      );
    }
    if (inventory.status === "zero") {
      return <Badge variant="destructive">0 · {t("store.produtos.estoque_zero")}</Badge>;
    }
    if (inventory.status === "stale") {
      return <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-300">
        {t("store.produtos.estoque_desatualizado")}{quantity == null ? "" : ` · ${quantity}`}
      </Badge>;
    }
    if (inventory.status === "not_linked") {
      return <Badge variant="secondary">{t("store.produtos.estoque_nao_vinculado")}</Badge>;
    }
    return <Badge variant="destructive">{t("store.produtos.estoque_indisponivel")}</Badge>;
  };
  const renderDescription = (product: Product, detailed = false) => {
    if (product.descriptionSource === "pending") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground" aria-live="polite">
          <Sparkles className="h-3.5 w-3.5 animate-pulse text-sofia" aria-hidden="true" />
          {t("store.produtos.descricao_gerando")}
        </span>
      );
    }
    if (!product.description) {
      return <span className="text-sm text-muted-foreground">{t("store.produtos.descricao_indisponivel")}</span>;
    }

    const generated = product.descriptionSource === "sofia-catalog" || product.descriptionSource === "sofia-web";
    const textClasses = detailed
      ? generated
        ? "line-clamp-2 text-sm leading-relaxed text-muted-foreground"
        : "text-sm leading-relaxed text-muted-foreground"
      : "line-clamp-2 text-sm leading-4 text-muted-foreground";
    return (
      <div className={`flex ${detailed ? "items-start" : "items-center"} gap-2`}>
        <span
          className={textClasses}
          title={detailed ? undefined : product.description}
        >
          {product.description}
        </span>
        {generated && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sofia/10 px-1.5 py-0.5 text-[10px] font-medium text-sofia"
            title={t("store.produtos.descricao_sofia_ajuda")}
          >
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            Sofia
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="min-w-0 max-w-full space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("store.produtos.title")}</h1>
          <p className="text-muted-foreground">{t("store.produtos.subtitle")}</p>
          {data && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("store.produtos.fonte")}: <strong>Wix + Omie Store</strong> · {t("store.produtos.atualizado")}{" "}
              <strong>Wix</strong> {formatDateTimeBR(data.lastUpdated)} ·{" "}
              <strong>{data.totalPublished}</strong> {t("store.produtos.publicados")} {t("store.produtos.de")}{" "}
              <strong>{data.totalRegistered}</strong> {t("store.produtos.cadastrados")}
              {data.totalHidden > 0 ? ` · ${data.totalHidden} ${t("store.produtos.ocultos")}` : ""}
              {data.inventory.status === "error" ? ` · ${t("store.produtos.estoque_erro")}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:items-end">
          <Button type="button" variant="outline" onClick={handleExport} disabled={isExporting}>
            <Download className="mr-2 h-4 w-4" aria-hidden="true" />
            {isExporting ? t("store.produtos.exportando") : t("store.produtos.exportar")}
          </Button>
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-right text-xs text-muted-foreground">
            <div className="font-medium text-foreground">{t("store.produtos.atualizacao_automatica")}</div>
            <div>{t("store.produtos.horario_atualizacao")}</div>
            <div>{t("store.produtos.horario_estoque")}</div>
          </div>
        </div>
      </div>

      {exportError && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 py-4">
            <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
            <div>
              <p className="font-medium">{t("store.produtos.exportar_erro")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{exportError}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder={t("store.produtos.buscar")}
          className="pl-9"
        />
      </div>

      {isError ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 py-6">
            <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
            <div>
              <p className="font-medium">{t("store.produtos.erro")}</p>
              <p className="text-sm text-muted-foreground mt-1">{error instanceof Error ? error.message : String(error)}</p>
            </div>
          </CardContent>
        </Card>
      ) : products.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <PackageOpen className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">{t("store.produtos.vazio")}</p>
          </CardContent>
        </Card>
      ) : (
      <Card className="min-w-0 max-w-full overflow-hidden shadow-sm border-border/50">
        <CardContent className="max-w-full overflow-x-auto overscroll-x-contain p-0">
          <Table className="min-w-[1120px] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[150px]">{t("store.produtos.sku")}</TableHead>
                <TableHead className="w-[210px]">{t("common.nome")}</TableHead>
                <TableHead className="w-[280px]">{t("store.produtos.descricao")}</TableHead>
                <TableHead className="w-[145px]">{t("common.valor")}</TableHead>
                <TableHead className="w-[120px]">{t("store.produtos.url")}</TableHead>
                <TableHead className="w-[165px]">
                  <div>{t("store.produtos.estoque")}</div>
                  <div className="mt-1 text-[10px] font-normal leading-tight text-muted-foreground">
                    {data?.inventory.lastUpdated
                      ? `${t("store.produtos.estoque_atualizado")} ${formatDateTimeBR(data.inventory.lastUpdated)}`
                      : t("store.produtos.estoque_sem_atualizacao")}
                  </div>
                </TableHead>
                <TableHead className="w-[145px]">{t("store.produtos.disponibilidade")}</TableHead>
                <TableHead className="sticky right-0 z-10 w-[70px] bg-background text-center shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.45)]">
                  {t("common.acoes")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id} className="h-14">
                  <TableCell className="max-w-[150px] whitespace-nowrap py-2 font-mono text-xs">
                    <span className="block truncate" title={p.skus.join(", ") || undefined}>{p.skus.length > 0 ? p.skus.join(", ") : "—"}</span>
                  </TableCell>
                  <TableCell className="max-w-[210px] whitespace-nowrap py-2">
                    <span className="block truncate text-sm font-medium" title={p.name}>{p.name}</span>
                  </TableCell>
                  <TableCell className="max-w-[280px] whitespace-normal py-2">
                    {renderDescription(p)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-2">{formatPrice(p.price, p.priceMax, p.currency)}</TableCell>
                  <TableCell className="py-2">
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-sofia hover:underline">
                        {t("store.produtos.abrir")} <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-2">{renderOmieInventory(p.omieInventory)}</TableCell>
                  <TableCell className="py-2">
                    <Badge variant={p.inStock === false ? "destructive" : "outline"}>
                      {p.inStock === false ? t("store.produtos.indisponivel") : t("store.produtos.disponivel")}
                    </Badge>
                  </TableCell>
                  <TableCell className="sticky right-0 z-10 bg-background py-2 text-center shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.45)]">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`${t("store.produtos.ver_ficha")}: ${p.name}`}
                      title={t("store.produtos.ver_ficha")}
                      onClick={() => setSelectedProduct(p)}
                    >
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      )}

      {!isError && total > pageSize && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{total} {t("store.produtos.total")}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(value => value - 1)}>
              {t("store.produtos.anterior")}
            </Button>
            <span>{page + 1} / {lastPage + 1}</span>
            <Button variant="outline" size="sm" disabled={page >= lastPage} onClick={() => setPage(value => value + 1)}>
              {t("store.produtos.proxima")}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={selectedProduct !== null} onOpenChange={(open) => !open && setSelectedProduct(null)}>
        {selectedProduct && (
          <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{selectedProduct.name}</DialogTitle>
              <DialogDescription>
                {selectedProduct.skus.length > 0
                  ? `${t("store.produtos.sku")}: ${selectedProduct.skus.join(", ")}`
                  : t("store.produtos.sku_sem")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-6">
              <section>
                <h3 className="mb-2 text-sm font-semibold">{t("store.produtos.descricao")}</h3>
                {renderDescription(selectedProduct, true)}
              </section>

              <div className="grid gap-x-8 gap-y-5 border-t border-border/60 pt-5 sm:grid-cols-2">
                <section className="min-w-0">
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("common.valor")}</h3>
                  <p className="text-sm">{formatPrice(selectedProduct.price, selectedProduct.priceMax, selectedProduct.currency)}</p>
                </section>
                <section className="min-w-0">
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("store.produtos.estoque")}</h3>
                  <div>{renderOmieInventory(selectedProduct.omieInventory)}</div>
                </section>
                <section className="min-w-0">
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("store.produtos.disponibilidade")}</h3>
                  <Badge variant={selectedProduct.inStock === false ? "destructive" : "outline"}>
                    {selectedProduct.inStock === false ? t("store.produtos.indisponivel") : t("store.produtos.disponivel")}
                  </Badge>
                </section>
                <section className="min-w-0 sm:col-span-2">
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("store.produtos.url")}</h3>
                  {selectedProduct.url ? (
                    <a href={selectedProduct.url} target="_blank" rel="noreferrer" className="break-all text-sm text-sofia hover:underline">
                      {selectedProduct.url}
                    </a>
                  ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                  )}
                </section>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
