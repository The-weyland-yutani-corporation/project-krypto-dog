import {
  ADMIN_SESSION_TTL_SECONDS,
  createAdminSessionToken,
  verifyAdminSessionToken,
} from "@/lib/admin-auth";

describe("admin session tokens", () => {
  const secret = "test-admin-session-secret";
  const issuedAt = new Date("2026-07-14T12:00:00.000Z");

  it("contains signed issued-at and expiry values", async () => {
    const token = await createAdminSessionToken(secret, issuedAt);
    const [issuedAtText, expiresAtText] = token.split(".");

    expect(Number(issuedAtText)).toBe(issuedAt.getTime() / 1000);
    expect(Number(expiresAtText)).toBe(
      issuedAt.getTime() / 1000 + ADMIN_SESSION_TTL_SECONDS,
    );
    await expect(
      verifyAdminSessionToken(
        token,
        secret,
        new Date(issuedAt.getTime() + 1_000),
      ),
    ).resolves.toBe(true);
  });

  it("rejects expired and forged tokens", async () => {
    const token = await createAdminSessionToken(secret, issuedAt);
    await expect(
      verifyAdminSessionToken(
        token,
        secret,
        new Date(
          issuedAt.getTime() + (ADMIN_SESSION_TTL_SECONDS + 1) * 1000,
        ),
      ),
    ).resolves.toBe(false);

    const forged = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    await expect(
      verifyAdminSessionToken(
        forged,
        secret,
        new Date(issuedAt.getTime() + 1_000),
      ),
    ).resolves.toBe(false);
  });
});
