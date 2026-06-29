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

  // Last-resort fallback so dev environments don't crash. Production
  // validateEnv() requires CRON_SECRET, so this branch is unreachable in prod.
  return "fallback";
}
