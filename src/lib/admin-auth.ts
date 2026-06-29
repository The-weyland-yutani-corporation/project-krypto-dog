export function getAdminSessionSecret(): string {
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

  if (process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_SESSION_SECRET or CRON_SECRET must be set");
  }

  // Last-resort fallback so local/test environments don't crash.
  return "fallback";
}
