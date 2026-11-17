import { useGetCalendarEvents } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar as CalendarIcon, MapPin } from "lucide-react";
import { useLang } from "@/contexts/language";
import { formatDateBR } from "@/lib/date";

export default function Calendario() {
  const { data: events, isLoading } = useGetCalendarEvents();
  const { t } = useLang();

  if (isLoading) {
    return <div className="p-8 space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (!events) return null;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("cal.title")}</h1>
        <p className="text-muted-foreground">{t("cal.subtitle")}</p>
      </div>

      <Card className="shadow-sm border-border/50">
        <CardHeader>
          <CardTitle className="text-xs font-bold tracking-[0.14em] uppercase text-muted-foreground">{t("cal.proximos")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {events.map((event) => (
              <div key={event.id} className="flex items-start gap-4 p-4 rounded-xl border border-border bg-card hover:bg-muted/50 transition-colors">
                <div className="flex flex-col items-center justify-center min-w-24 h-16 px-2 rounded-lg shrink-0" style={{ backgroundColor: `${event.color}15`, color: event.color }}>
                  <span className="text-sm font-display font-bold leading-none">{formatDateBR(event.date)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-bold text-foreground truncate">{event.label}</h3>
                  <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                    {event.location && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {event.location}
                      </span>
                    )}
                    {event.type && (
                      <span className="flex items-center gap-1">
                        <CalendarIcon className="h-3 w-3" />
                        {event.type}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
