import { Construction } from "lucide-react";
import { useLang } from "@/contexts/language";

export default function Pedidos() {
  const { t, lang } = useLang();

  return (
    <div className="min-h-[70vh] flex flex-col animate-in fade-in duration-300">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">
          {t("store.pedidos.title")}
        </h1>
        <p className="text-muted-foreground">{t("store.pedidos.subtitle")}</p>
      </div>
      <div className="flex flex-1 items-center justify-center py-20 text-center">
        <div>
          <Construction className="mx-auto mb-4 h-12 w-12 text-muted-foreground/35" />
          <p className="text-xl font-semibold">
            {lang === "fr" ? "En construction" : "Em Construção"}
          </p>
        </div>
      </div>
    </div>
  );
}