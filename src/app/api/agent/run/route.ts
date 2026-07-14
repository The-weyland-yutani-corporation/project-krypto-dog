import { NextRequest, NextResponse } from "next/server";
import { executeAgentRun } from "@/agent/run-flow";
import { flushPostHog } from "@/lib/posthog";
import { timingSafeStringEqual } from "@/lib/secure-compare";

function isValidCronSecret(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;

  return timingSafeStringEqual(provided, expected);
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const outcome = await executeAgentRun({
      triggerSource: "cron",
      idempotencyKey:
        request.headers.get("x-idempotency-key") ?? undefined,
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
    console.error("[api/agent/run] Unhandled orchestration failure:", error);
    return NextResponse.json(
      { error: "Agent orchestration failed before a result was available" },
      { status: 500 },
    );
  } finally {
    try {
      await flushPostHog();
    } catch (error) {
      console.error("[api/agent/run] Failed to flush analytics:", error);
    }
  }
}
