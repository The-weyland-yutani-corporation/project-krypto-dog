import { NextRequest, NextResponse } from "next/server";
import {
  getAdminSessionSecret,
  verifyAdminSessionToken,
} from "./admin-auth";

export async function requireAdminSession(
  request: NextRequest,
): Promise<NextResponse | null> {
  const token = request.cookies.get("krypto-admin-token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return (await verifyAdminSessionToken(token, getAdminSessionSecret()))
      ? null
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
