import { NextRequest, NextResponse } from "next/server";
import { executeAgentRun } from "@/agent/run-flow";

export async function POST(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await executeAgentRun({ triggerSource: "cron" });

  switch (outcome.kind) {
    case "mutex":
      return NextResponse.json({ error: outcome.message }, { status: 409 });
    case "upstream_error":
      return NextResponse.json(outcome.result, { status: outcome.httpStatus });
    case "ok":
      return NextResponse.json(outcome.result, { status: 200 });
  }
}
