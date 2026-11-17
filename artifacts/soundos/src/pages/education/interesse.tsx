import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { useLang } from "@/contexts/language";
import { InteresseEmbedCard } from "./interesse-embed-card";

export default function EducationInteresse() {
  const { t } = useLang();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="space-y-2">
        <Link
          href="/education/cursos"
          className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
          data-testid="link-voltar-eventos"
        >
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          {t("edu.interesse.voltar")}
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("edu.interesse.title")}</h1>
          <p className="text-muted-foreground">{t("edu.interesse.subtitle")}</p>
        </div>
      </div>
      <InteresseEmbedCard />
    </div>
  );
}
