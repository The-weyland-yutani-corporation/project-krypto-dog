import { NextResponse } from "next/server";

import { buildHealthPayload } from "@/lib/health";

// Non-sensitive liveness/readiness probe for the local harness and operators.
// No authentication and no database access: it returns only the effective
// rollout mode and optional harness mode, and is always sent no-store.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(buildHealthPayload(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Fail loud but without leaking configuration internals.
    return NextResponse.json(
      { status: "error", error: "Invalid rollout configuration" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
