"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface EquityPoint {
  label: string;
  agent: number;
  cash: number;
  buyHold: number;
}

export interface ScenarioBar {
  name: string;
  value: number;
}

function formatCurrencyValue(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `$${numeric.toFixed(2)}` : String(value);
}

export function BacktestSnapshot({
  equity,
  scenarios,
}: {
  equity: EquityPoint[];
  scenarios: ScenarioBar[];
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.35fr_0.9fr]">
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Equity curve</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Agent equity against cash and buy-and-hold baselines
            </p>
          </div>
          <Badge variant="info">EvilCharts / Recharts</Badge>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={equity} margin={{ left: 8, right: 8, top: 12, bottom: 0 }}>
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  tickFormatter={(value) => `$${value}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    color: "var(--foreground)",
                  }}
                  labelStyle={{ color: "var(--muted-foreground)" }}
                  formatter={(value, name) => [formatCurrencyValue(value), name]}
                />
                <Line
                  type="monotone"
                  dataKey="agent"
                  stroke="var(--chart-equity)"
                  strokeWidth={3}
                  dot={false}
                  name="Agent"
                />
                <Line
                  type="monotone"
                  dataKey="cash"
                  stroke="var(--chart-profit)"
                  strokeDasharray="6 5"
                  strokeWidth={2}
                  dot={false}
                  name="Cash"
                />
                <Line
                  type="monotone"
                  dataKey="buyHold"
                  stroke="var(--chart-benchmark)"
                  strokeWidth={2}
                  dot={false}
                  name="Buy & hold"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scenario P&L</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Fixture results after fees and modeled constraints
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={scenarios} margin={{ left: 8, right: 8, top: 12, bottom: 0 }}>
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                  tickFormatter={(value) => `$${value}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    color: "var(--foreground)",
                  }}
                  formatter={(value) => [formatCurrencyValue(value), "P&L"]}
                />
                <Bar dataKey="value" radius={[8, 8, 2, 2]}>
                  {scenarios.map((scenario) => (
                    <Cell
                      key={scenario.name}
                      fill={
                        scenario.value >= 0
                          ? "var(--chart-profit)"
                          : "var(--chart-loss)"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
