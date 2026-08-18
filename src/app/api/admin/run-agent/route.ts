import { NextRequest, NextResponse } from "next/server";
import { executeAgentRun } from "@/agent/run-flow";
import { checkSameOrigin } from "@/lib/csrf";
import { requireAdminOperator } from "@/lib/admin-route-auth";
import { readRequiredRolloutMode } from "@/lib/required-rollout-mode";
import { RequiredRolloutModeError } from "@/trading/errors";
import {
  AdmissionCapacityError,
  createExecutionDeadline,
  type ExecutionDeadline,
} from "@/lib/execution-envelope";
import { tryAcquireRunAdmission } from "@/lib/run-admission";
import { requestIdFromHeaders } from "@/lib/correlation";
import { recordOperatorAuditEvent } from "@/lib/operator-audit";

// We intentionally do *not* accept the cron secret here. If `CRON_SECRET` ever
// leaks, an attacker still cannot drive the agent through the admin surface.
export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;
  const auth = await requireAdminOperator(request, "RUN_AGENT");
  if (!auth.ok) return auth.response;
  const requestId = requestIdFromHeaders(request.headers);

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
          route: "/api/admin/run-agent",
          failureCode: "required-mode-invalid",
        }),
      );
      return NextResponse.json(
        { error: "Invalid required rollout mode" },
        { status: 400 },
      );
    }
    await recordOperatorAuditEvent({
      operator: auth.operator,
      action: "RUN_AGENT",
      requestHeaders: request.headers,
      requestId,
      outcome: "REQUESTED",
    });
    deadline = createExecutionDeadline({ signal: request.signal });
    releaseAdmission = tryAcquireRunAdmission(deadline);
    const outcome = await executeAgentRun({
      triggerSource: "admin",
      requestId,
      idempotencyKey:
        request.headers.get("x-idempotency-key") ?? undefined,
      ...(requiredMode ? { requiredMode } : {}),
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
          route: "/api/admin/run-agent",
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
          route: "/api/admin/run-agent",
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
        route: "/api/admin/run-agent",
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
