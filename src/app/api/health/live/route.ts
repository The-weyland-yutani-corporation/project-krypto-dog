// Liveness probe: process-only, unauthenticated, exposes no configuration,
// database, or trading state. Returning a response at all proves the Node
// process is alive and its event loop is responsive; nothing else is
// checked here on purpose. ./ready currently reports the same always-ready
// signal (see that route for why it doesn't hook shutdown signals).
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
