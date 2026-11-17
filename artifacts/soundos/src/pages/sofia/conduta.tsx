import { useLang } from "@/contexts/language";
import { CanalInstagramCard } from "./canal-instagram-card";
import { CanalWhatsappCard } from "./canal-whatsapp-card";

export default function SofiaConduta() {
  const { t } = useLang();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("sofia.conduta.title")}</h1>
        <p className="text-muted-foreground text-sm max-w-2xl">{t("sofia.conduta.subtitle")}</p>
      </div>

      <div className="space-y-5">
        <CanalInstagramCard />

        <CanalWhatsappCard />
      </div>
    </div>
  );
}
