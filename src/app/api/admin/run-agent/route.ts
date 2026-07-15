import { NextRequest, NextResponse } from "next/server";
import { executeAgentRun } from "@/agent/run-flow";
import { checkSameOrigin } from "@/lib/csrf";
import { requireAdminSession } from "@/lib/admin-route-auth";
import { flushPostHog } from "@/lib/posthog";
import { readRequiredRolloutMode } from "@/lib/required-rollout-mode";
import { RequiredRolloutModeError } from "@/trading/errors";

// We intentionally do *not* accept the cron secret here. If `CRON_SECRET` ever
// leaks, an attacker still cannot drive the agent through the admin surface.
export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;
  const auth = await requireAdminSession(request);
  if (auth) return auth;

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
    const outcome = await executeAgentRun({
      triggerSource: "admin",
      idempotencyKey:
        request.headers.get("x-idempotency-key") ?? undefined,
      ...(requiredMode ? { requiredMode } : {}),
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
    console.error(
      "[api/admin/run-agent] Unhandled orchestration failure:",
      error,
    );
    return NextResponse.json(
      { error: "Agent orchestration failed before a result was available" },
      { status: 500 },
    );
  } finally {
    try {
      await flushPostHog();
    } catch (error) {
      console.error(
        "[api/admin/run-agent] Failed to flush analytics:",
        error,
      );
    }
  }
}
