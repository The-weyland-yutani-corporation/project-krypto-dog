import { timingSafeStringEqual } from "@/lib/secure-compare";

export function isValidCronSecret(
  provided: string | null,
  expected = process.env.CRON_SECRET,
): boolean {
  return Boolean(
    provided &&
      expected &&
      timingSafeStringEqual(provided, expected),
  );
}
