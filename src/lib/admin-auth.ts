import { timingSafeStringEqual } from "./secure-compare";

export const ADMIN_SESSION_TTL_SECONDS = 24 * 60 * 60;
const ALLOWED_CLOCK_SKEW_SECONDS = 60;

export function getAdminSessionSecret(): string {
  const dedicated = process.env.ADMIN_SESSION_SECRET;
  if (dedicated) return dedicated;

  if (process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_SESSION_SECRET must be set");
  }

  return process.env.CRON_SECRET || "fallback";
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createAdminSessionToken(
  secret: string,
  now = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + ADMIN_SESSION_TTL_SECONDS;
  const payload = `${issuedAt}.${expiresAt}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifyAdminSessionToken(
  token: string,
  secret: string,
  now = new Date(),
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [issuedAtText, expiresAtText, signature] = parts;
  if (!/^\d+$/.test(issuedAtText) || !/^\d+$/.test(expiresAtText)) {
    return false;
  }

  const issuedAt = Number(issuedAtText);
  const expiresAt = Number(expiresAtText);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > ADMIN_SESSION_TTL_SECONDS ||
    issuedAt > nowSeconds + ALLOWED_CLOCK_SKEW_SECONDS ||
    expiresAt <= nowSeconds
  ) {
    return false;
  }

  const payload = `${issuedAtText}.${expiresAtText}`;
  const expected = await hmacHex(secret, payload);
  return timingSafeStringEqual(signature, expected);
}
