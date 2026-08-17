import { NextRequest, NextResponse } from "next/server";
import { executeAgentRun } from "@/agent/run-flow";
import { isValidCronSecret } from "@/lib/cron-auth";
import { readRequiredRolloutMode } from "@/lib/required-rollout-mode";
import { RequiredRolloutModeError } from "@/trading/errors";
import { resolveTradingMode } from "@/trading/strategy-config";
import {
  AdmissionCapacityError,
  createExecutionDeadline,
  type ExecutionDeadline,
} from "@/lib/execution-envelope";
import { tryAcquireRunAdmission } from "@/lib/run-admission";
import { requestIdFromHeaders } from "@/lib/correlation";

export async function POST(request: NextRequest) {
  const requestId = requestIdFromHeaders(request.headers);
  if (!isValidCronSecret(request.headers.get("x-cron-secret"))) {
    console.error(
      JSON.stringify({
        eventType: "auth_provenance_mismatch",
        requestId,
        route: "/api/agent/run",
        failureCode: "cron-auth-rejected",
      }),
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let deadline: ExecutionDeadline | undefined;
  let releaseAdmission: (() => void) | undefined;
  try {
    let requiredMode: ReturnType<typeof readRequiredRolloutMode>;
    try {
      requiredMode = readRequiredRolloutMode(request);
    } catch {
      console.error(
        JSON.stringify({
          eventType: "auth_provenance_mismatch",
          requestId,
          route: "/api/agent/run",
          failureCode: "required-mode-invalid",
        }),
      );
      return NextResponse.json(
        { error: "Invalid required rollout mode" },
        { status: 400 },
      );
    }
    if (!requiredMode) {
      console.error(
        JSON.stringify({
          eventType: "auth_provenance_mismatch",
          requestId,
          route: "/api/agent/run",
          failureCode: "required-mode-missing",
        }),
      );
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
      requestId,
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
      console.error(
        JSON.stringify({
          eventType: "readiness_capacity_failure",
          requestId,
          route: "/api/agent/run",
          failureCode: error.code,
        }),
      );
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    if (error instanceof RequiredRolloutModeError) {
      console.error(
        JSON.stringify({
          eventType: "auth_provenance_mismatch",
          requestId,
          route: "/api/agent/run",
          failureCode: "required-mode-changed",
        }),
      );
      return NextResponse.json(
        {
          error: "Rollout mode changed before the run started",
          expectedMode: error.expectedMode,
          actualMode: error.actualMode,
        },
        { status: 409 },
      );
    }
    console.error(
      JSON.stringify({
        eventType: "route_run_failure",
        requestId,
        route: "/api/agent/run",
        failureCode: "unhandled-orchestration",
      }),
    );
    return NextResponse.json(
      { error: "Agent orchestration failed before a result was available" },
      { status: 500 },
    );
  } finally {
    releaseAdmission?.();
    deadline?.dispose();
  }
}
