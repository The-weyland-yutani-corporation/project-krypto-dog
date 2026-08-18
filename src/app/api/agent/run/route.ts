import { NextRequest, NextResponse } from "next/server";
import { executeAgentRun } from "@/agent/run-flow";
import { isValidCronSecret } from "@/lib/cron-auth";
import { flushPostHog } from "@/lib/posthog";
import { readRequiredRolloutMode } from "@/lib/required-rollout-mode";
import { RequiredRolloutModeError } from "@/trading/errors";
import { resolveTradingMode } from "@/trading/strategy-config";
import {
  AdmissionCapacityError,
  createExecutionDeadline,
  type ExecutionDeadline,
} from "@/lib/execution-envelope";
import { tryAcquireRunAdmission } from "@/lib/run-admission";

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let deadline: ExecutionDeadline | undefined;
  let releaseAdmission: (() => void) | undefined;
  try {
    let requiredMode: ReturnType<typeof readRequiredRolloutMode>;
    try {
      requiredMode = readRequiredRolloutMode(request);
    } catch {
      return NextResponse.json(
        { error: "Invalid required rollout mode" },
        { status: 400 },
      );
    }
    if (!requiredMode) {
      return NextResponse.json(
        { error: "Required rollout mode is missing" },
        { status: 400 },
      );
    }
    if (request.headers.get("x-krypto-mode-probe") === "no-mutation") {
      const actualMode = resolveTradingMode();
      if (actualMode !== requiredMode) {
        throw new RequiredRolloutModeError(requiredMode, actualMode);
      }
      return NextResponse.json({
        modeProbe: true,
        expectedMode: requiredMode,
        actualMode,
      });
    }
    deadline = createExecutionDeadline({ signal: request.signal });
    releaseAdmission = tryAcquireRunAdmission(deadline);
    const outcome = await executeAgentRun({
      triggerSource: "cron",
      idempotencyKey:
        request.headers.get("x-idempotency-key") ?? undefined,
      requiredMode,
      signal: request.signal,
      deadline,
    });

    switch (outcome.kind) {
      case "mutex":
        return NextResponse.json(
          { error: outcome.message, result: outcome.result },
          { status: 409 },
        );
      case "upstream_error":
        return NextResponse.json(outcome.result, {
          status: outcome.httpStatus,
        });
      case "ok":
        return NextResponse.json(outcome.result, { status: 200 });
    }
  } catch (error) {
    if (error instanceof AdmissionCapacityError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    if (error instanceof RequiredRolloutModeError) {
      return NextResponse.json(
        {
          error: "Rollout mode changed before the run started",
          expectedMode: error.expectedMode,
          actualMode: error.actualMode,
        },
        { status: 409 },
      );
    }
    console.error("[api/agent/run] Unhandled orchestration failure:", error);
    return NextResponse.json(
      { error: "Agent orchestration failed before a result was available" },
      { status: 500 },
    );
  } finally {
    if (deadline && deadline.remainingMs() > 0) {
      try {
        await flushPostHog({ deadline });
      } catch (error) {
        console.error("[api/agent/run] Failed to flush analytics:", error);
      }
    }
    releaseAdmission?.();
    deadline?.dispose();
  }
}
