import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { executeAgentRun } from "@/agent/run-flow";

function isValidCronSecret(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get("x-cron-secret"))) {
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
