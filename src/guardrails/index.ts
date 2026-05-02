import { checkDrawdown } from "./drawdown-check";
import { checkCooldown } from "./cooldown-check";
import { SystemLockedError } from "@/lib/types";

export async function runPreFlightChecks(): Promise<{
  skip: boolean;
  reason?: string;
}> {
  try {
    await checkDrawdown();
  } catch (err) {
    if (err instanceof SystemLockedError) {
      return { skip: true, reason: "System locked: max drawdown reached" };
    }
    throw err;
  }

  const cooldownActive = await checkCooldown();
  if (cooldownActive) {
    return {
      skip: true,
      reason: "Cooldown active: last trade was less than 2 hours ago",
    };
  }

  return { skip: false };
}
