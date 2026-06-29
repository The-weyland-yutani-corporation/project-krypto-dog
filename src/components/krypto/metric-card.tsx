import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: "default" | "success" | "warning" | "destructive" | "info";
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
    info: "text-info",
  }[tone];

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </p>
        <div className={cn("mt-3 text-2xl font-semibold tabular-nums", toneClass)}>
          {value}
        </div>
        {detail && <div className="mt-2 text-xs text-muted-foreground">{detail}</div>}
      </CardContent>
    </Card>
  );
}
