"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface OperationsPanelProps {
  isRunning: boolean;
  isLocked: boolean;
  isOperatorPaused: boolean;
}

type Status =
  | { kind: "idle" }
  | { kind: "info"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function OperationsPanel({
  isRunning,
  isLocked,
  isOperatorPaused,
}: OperationsPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Optimistic local-only flag so the Run button feels responsive before the
  // first server-driven re-render lands. Backend mutex remains source of truth.
  const [optimisticRunning, setOptimisticRunning] = useState(false);

  const runDisabled =
    pending || isRunning || optimisticRunning || isLocked || isOperatorPaused;

  async function handleRun() {
    setOptimisticRunning(true);
    setStatus({ kind: "info", message: "Starting agent run…" });
    try {
      const res = await postJson("/api/admin/run-agent");
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }

      if (res.ok) {
        const summary =
          (body.action as string | undefined) ??
          (body.status as string | undefined) ??
          "completed";
        setStatus({ kind: "success", message: `Run ${summary}` });
      } else {
        setStatus({
          kind: "error",
          message: `HTTP ${res.status}: ${body.error ?? body.status ?? "unknown"}`,
        });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setOptimisticRunning(false);
      startTransition(() => router.refresh());
    }
  }

  async function handlePauseToggle() {
    const next = !isOperatorPaused;
    setStatus({
      kind: "info",
      message: next ? "Pausing agent…" : "Resuming agent…",
    });
    try {
      const res = await postJson("/api/admin/pause", { paused: next });
      if (res.ok) {
        setStatus({
          kind: "success",
          message: next ? "Agent paused" : "Agent resumed",
        });
      } else {
        const body = await res.json().catch(() => ({}));
        setStatus({
          kind: "error",
          message: `HTTP ${res.status}: ${body.error ?? "failed"}`,
        });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      startTransition(() => router.refresh());
    }
  }

  async function handleReleaseLease() {
    if (
      !window.confirm(
        "Force-release the run lease?\n\nUse only if you're SURE the previous run is dead.\nIf an agent is genuinely running this can cause concurrent trades.",
      )
    ) {
      return;
    }
    setStatus({ kind: "info", message: "Releasing run lease…" });
    try {
      const res = await postJson("/api/admin/release-run-lease");
      if (res.ok) {
        setStatus({ kind: "success", message: "Run lease released" });
      } else {
        const body = await res.json().catch(() => ({}));
        setStatus({
          kind: "error",
          message: `HTTP ${res.status}: ${body.error ?? "failed"}`,
        });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      startTransition(() => router.refresh());
    }
  }

  const statusColor =
    status.kind === "success"
      ? "text-success"
      : status.kind === "error"
        ? "text-destructive"
        : status.kind === "info"
          ? "text-info"
          : "text-muted-foreground";

  return (
    <Card aria-label="Operations">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Operations</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Manually trigger the agent or change its operating state.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={handleRun}
            disabled={runDisabled}
            aria-disabled={runDisabled}
            title={
              isLocked
                ? "Cannot run while drawdown safety lock is engaged"
                : isOperatorPaused
                  ? "Resume the agent first"
                  : isRunning || optimisticRunning
                    ? "Run already in progress"
                    : "Run the agent now"
            }
          >
            ▶ Run Agent Now
          </Button>

          <Button
            type="button"
            onClick={handlePauseToggle}
            disabled={pending}
            variant={isOperatorPaused ? "warning" : "secondary"}
          >
            {isOperatorPaused ? "▶ Resume Agent" : "⏸ Pause Agent"}
          </Button>

          <Button
            type="button"
            onClick={handleReleaseLease}
            disabled={pending || !isRunning}
            variant="destructive"
            title={
              !isRunning
                ? "No stuck lease to release"
                : "Force-release the run lease (dangerous)"
            }
          >
            ⚠ Release Run Lease
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {isLocked && (
          <Alert variant="destructive">
            🔒 <strong>Drawdown safety lock engaged.</strong> The agent will not
            trade. This lock is intentionally not clearable from this panel; clear
            it via the explicit override flow only after you understand the cause.
          </Alert>
        )}

        {isOperatorPaused && (
          <Alert variant="warning" className="mt-3">
            ⏸ <strong>Agent paused by operator.</strong> The agent will not trade
            until it is resumed.
          </Alert>
        )}

        {status.kind !== "idle" && (
          <p className={`mt-3 text-sm ${statusColor}`}>{status.message}</p>
        )}
      </CardContent>
    </Card>
  );
}
