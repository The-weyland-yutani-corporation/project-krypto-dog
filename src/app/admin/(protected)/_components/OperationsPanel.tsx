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
  canRecoverLease: boolean;
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
  canRecoverLease,
}: OperationsPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Optimistic local-only flag so the Run button feels responsive before the
  // first server-driven re-render lands. The backend lease remains authoritative.
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
        "Recover the expired run lease?\n\nThe server will refuse an active owned lease.",
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

  async function handleUnlock() {
    const reason = window.prompt(
      "Explain why the drawdown safety lock can be cleared (minimum 10 characters):",
    );
    if (!reason || reason.trim().length < 10) {
      setStatus({
        kind: "error",
        message: "Unlock cancelled: an audit reason is required",
      });
      return;
    }
    if (
      !window.confirm(
        "Clear the drawdown safety lock?\n\nThis action is journaled and must follow a review of recent runs and trades.",
      )
    ) {
      return;
    }

    setStatus({ kind: "info", message: "Clearing safety lock..." });
    try {
      const res = await postJson("/api/admin/unlock", {
        confirm: "UNLOCK",
        reason: reason.trim(),
      });
      if (res.ok) {
        setStatus({
          kind: "success",
          message: "Safety lock cleared; agent remains paused",
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
            disabled={pending || !canRecoverLease}
            variant="destructive"
            title={
              !isRunning
                ? "No run lease to recover"
                : canRecoverLease
                  ? "Recover the expired or legacy unowned lease"
                  : "Active owned leases cannot be released"
            }
          >
            Recover Expired Lease
          </Button>

          {isLocked && (
            <Button
              type="button"
              onClick={handleUnlock}
              disabled={pending || isRunning}
              variant="destructive"
              title={
                isRunning
                  ? "Wait for the active run lease to finish"
                  : "Clear the safety lock with an audited reason"
              }
            >
              Clear Safety Lock
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {isLocked && (
          <Alert variant="destructive">
            🔒 <strong>Drawdown safety lock engaged.</strong> The agent will not
            trade. Review recent runs and trades before using the audited
            override.
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
