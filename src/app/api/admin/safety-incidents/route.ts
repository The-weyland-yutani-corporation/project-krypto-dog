import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { requireAdminSession } from "@/lib/admin-route-auth";
import { checkSameOrigin } from "@/lib/csrf";
import {
  SAFETY_INCIDENT_SEVERITIES,
  SAFETY_INCIDENT_STATUSES,
  safetyIncidentRepository,
} from "@/lib/safety-incidents";
import {
  SAFETY_ACTOR_ROLES,
} from "@/lib/safety-roster";

const EvidencePrimitive = z.union([
  z.string().max(240),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const LifecycleBody = z
  .object({
    action: z.enum(["ACKNOWLEDGE", "ESCALATE", "RESOLVE"]),
    incidentId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    actorId: z.string().trim().min(1).max(120),
    actorRole: z.enum(SAFETY_ACTOR_ROLES),
    reason: z.string().trim().min(3).max(240),
    evidence: z.record(z.string(), EvidencePrimitive).optional(),
    signedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    signature: z
      .string()
      .min(80)
      .max(128)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

const ListQuery = z
  .object({
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
      .transform(Number)
      .optional(),
    severity: z.enum(SAFETY_INCIDENT_SEVERITIES).optional(),
    status: z.enum(SAFETY_INCIDENT_STATUSES).optional(),
    includeContext: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  const auth = await requireAdminSession(request);
  if (auth) return auth;

  const parsed = ListQuery.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid safety incident list query" },
      { status: 400 },
    );
  }

  const incidents = await safetyIncidentRepository.listLatest(parsed.data);
  return NextResponse.json({ incidents }, { status: 200 });
}

export async function POST(request: NextRequest) {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;
  const auth = await requireAdminSession(request);
  if (auth) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid safety incident lifecycle body" },
      { status: 400 },
    );
  }
  const parsed = LifecycleBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid safety incident lifecycle body" },
      { status: 400 },
    );
  }
  return NextResponse.json(
    {
      error:
        "Human lifecycle changes are unavailable through the shared admin session; use the protected signed owner/migrator operation.",
    },
    { status: 503 },
  );
}
