import { NextResponse } from "next/server";
import crypto from "crypto";

function getAdminSessionSecret(): string {
  const dedicated = process.env.ADMIN_SESSION_SECRET;
  if (dedicated) return dedicated;

  const fallback = process.env.CRON_SECRET;
  if (fallback) {
    console.warn(
      "[auth] ADMIN_SESSION_SECRET not set — falling back to CRON_SECRET. " +
        "Set ADMIN_SESSION_SECRET in production to decouple admin sessions from the cron auth secret."
    );
    return fallback;
  }

  // Last-resort fallback so dev environments don't crash. Production
  // validateEnv() requires CRON_SECRET, so this branch is unreachable in prod.
  return "fallback";
}

function signToken(secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("admin-authenticated")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory rate limit (per-instance). 5 attempts / 15 min per source IP.
// Limitation: each Vercel function instance has its own counter, so a
// determined attacker hitting many cold-started instances could exceed the
// nominal limit. Acceptable for a single-user single-region paper-trading
// deployment. For multi-instance hardening, swap for an Upstash/Redis store.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_MAX_TRACKED_IPS = 1000;
const attemptsByIp = new Map<string, number[]>();

function getClientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfterSec?: number } {
  // Local development convenience: rate-limit only in production. In dev,
  // browsers don't send x-forwarded-for so every request lands in a single
  // "unknown" bucket and a few mistyped passwords lock you out for 15 min.
  if (process.env.NODE_ENV !== "production") {
    return { allowed: true };
  }

  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (attemptsByIp.get(ip) ?? []).filter((t) => t > cutoff);

  if (recent.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    const oldest = recent[0];
    const retryAfterSec = Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000);
    attemptsByIp.set(ip, recent);
    return { allowed: false, retryAfterSec: Math.max(retryAfterSec, 1) };
  }

  recent.push(now);
  attemptsByIp.set(ip, recent);

  // Opportunistic GC: cap the Map so a slow trickle of unique IPs over a
  // long-lived instance can't grow it without bound. Cheap (runs on every
  // call but no-op until the threshold is crossed).
  if (attemptsByIp.size > RATE_LIMIT_MAX_TRACKED_IPS) {
    for (const [key, times] of attemptsByIp) {
      const stillRecent = times.filter((t) => t > cutoff);
      if (stillRecent.length === 0) attemptsByIp.delete(key);
      else if (stillRecent.length !== times.length) attemptsByIp.set(key, stillRecent);
    }
  }

  return { allowed: true };
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSec ?? 60) },
      }
    );
  }

  const { password } = await request.json();
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || password !== adminPassword) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = signToken(getAdminSessionSecret());

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
