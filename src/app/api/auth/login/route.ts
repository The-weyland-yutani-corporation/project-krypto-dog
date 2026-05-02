import { NextResponse } from "next/server";
import crypto from "crypto";

function signToken(secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("admin-authenticated")
    .digest("hex");
}

export async function POST(request: Request) {
  const { password } = await request.json();
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || password !== adminPassword) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const secret = process.env.CRON_SECRET || "fallback";
  const token = signToken(secret);

  const response = NextResponse.json({ success: true });
  response.cookies.set("krypto-admin-token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });

  return response;
}
