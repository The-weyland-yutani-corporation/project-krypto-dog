import Link from "next/link";
import { Activity, Bot, ShieldCheck, Terminal } from "lucide-react";
import { BacktestSnapshot } from "@/components/charts/backtest-snapshot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getBacktestSnapshotData } from "@/lib/backtest-display";

export default function Home() {
  const chartData = getBacktestSnapshotData();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-6 py-10 lg:px-8 lg:py-16">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-info/30 bg-info/10 text-xl">
              🐕
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Project Krypto</p>
              <p className="text-xs text-muted-foreground">ETH/USDC autonomous paper desk</p>
            </div>
          </div>
          <Button asChild>
            <Link href="/admin">Open console</Link>
          </Button>
        </header>

        <div className="grid gap-8 lg:grid-cols-[0.92fr_1.08fr] lg:items-center">
          <div>
            <Badge variant="info">Paper trading only · simulation POC</Badge>
            <h1 className="mt-6 max-w-3xl text-5xl font-semibold tracking-[-0.06em] text-foreground md:text-7xl">
              Autonomous trading needs an operator console.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
              Project Krypto runs a guarded ETH/USDC paper-trading agent with
              journaled reasoning, drawdown controls, deterministic backtests,
              and verified deployments. Every trade is simulated, including in production.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href="/admin">Monitor agent</Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <Link href="/admin/trades">View trade ledger</Link>
              </Button>
            </div>
            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {[
                { icon: ShieldCheck, label: "Guardrails", value: "$150 lock" },
                { icon: Bot, label: "Agent", value: "journaled runs" },
                { icon: Activity, label: "Backtests", value: "cash vs hold" },
              ].map((item) => (
                <Card key={item.label} className="bg-card/70">
                  <CardContent className="p-4">
                    <item.icon className="h-4 w-4 text-info" />
                    <p className="mt-3 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                      {item.label}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-foreground">{item.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <Card className="relative overflow-hidden border-info/20 bg-card/80">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-info/80 to-transparent" />
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5 text-info" />
                  Evidence terminal
                </CardTitle>
                <Badge variant="success">simulated portfolio</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <BacktestSnapshot {...chartData} />
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
