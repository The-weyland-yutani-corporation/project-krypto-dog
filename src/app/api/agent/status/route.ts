import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { agentJournal } from "@/db/schema";
import { isValidCronSecret } from "@/lib/cron-auth";
import { resolveTradingMode } from "@/trading/strategy-config";

export const dynamic = "force-dynamic";
const DATABASE_CHALLENGE_PATTERN =
  /^deployment-smoke-binding-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get("x-cron-secret"))) {
    return NextResponse.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  try {
    const challenge = request.headers.get("x-database-challenge");
    if (
      challenge !== null &&
      !DATABASE_CHALLENGE_PATTERN.test(challenge)
    ) {
      return NextResponse.json(
        { error: "Invalid database challenge" },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    let databaseBinding: boolean | null = null;
    if (challenge) {
      const [binding] = await db
        .select({ id: agentJournal.id })
        .from(agentJournal)
        .where(
          and(
            eq(agentJournal.id, challenge),
            sql`${agentJournal.marketConditions} ->> 'event' = 'deployment-smoke-binding'`,
          ),
        )
        .limit(1);
      databaseBinding = binding !== undefined;
    }
    return NextResponse.json(
      {
        rolloutMode: resolveTradingMode(),
        databaseBinding,
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      { error: "Invalid rollout configuration" },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
