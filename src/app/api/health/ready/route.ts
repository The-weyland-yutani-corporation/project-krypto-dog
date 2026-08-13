// Readiness probe: process-only, unauthenticated, exposes no configuration,
// database, or trading state. Deliberately always reports ready (200) with
// no shutdown-signal interception: installing a SIGTERM/SIGINT listener to
// flip this to not-ready would itself suppress Node's default
// terminate-on-signal behavior, which can leave the container hanging until
// Azure Container Apps escalates to SIGKILL. Draining/graceful-shutdown
// coordination belongs to the platform (Container Apps revision draining),
// not to this process-only probe.
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
