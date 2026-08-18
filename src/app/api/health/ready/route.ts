import { NextResponse } from "next/server";
import { evaluateReadiness } from "@/lib/readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await evaluateReadiness();
  return NextResponse.json(
    {
      status: readiness.ready ? "ready" : "not_ready",
      reasons: readiness.reasons,
    },
    {
      status: readiness.ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
