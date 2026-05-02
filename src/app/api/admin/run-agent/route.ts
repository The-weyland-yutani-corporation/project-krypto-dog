import { NextRequest, NextResponse } from "next/server";
import { executeAgentRun } from "@/agent/run-flow";
import { checkSameOrigin } from "@/lib/csrf";

// Admin auth (cookie + HMAC) is enforced by `src/middleware.ts` — anything
// reaching this handler has already passed the admin session check.
//
// We intentionally do *not* accept the cron secret here. If `CRON_SECRET` ever
// leaks, an attacker still cannot drive the agent through the admin surface.
export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;

  const outcome = await executeAgentRun({ triggerSource: "admin" });

  switch (outcome.kind) {
    case "mutex":
      return NextResponse.json({ error: outcome.message }, { status: 409 });
    case "upstream_error":
      return NextResponse.json(outcome.result, { status: outcome.httpStatus });
    case "ok":
      return NextResponse.json(outcome.result, { status: 200 });
  }
}
