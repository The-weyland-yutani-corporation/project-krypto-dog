import { checkDrawdown } from "./drawdown-check";
import { checkCooldown } from "./cooldown-check";
import { checkOperatorPaused } from "./operator-pause-check";
import { SystemLockedError } from "@/lib/types";

export type PreFlightResult = { skip: boolean; reason?: string };

export async function runPreFlightChecks(): Promise<PreFlightResult> {
  if (await checkOperatorPaused()) {
    return { skip: true, reason: "Agent paused by operator" };
  }

  try {
    await checkDrawdown();
  } catch (err) {
    if (err instanceof SystemLockedError) {
      return { skip: true, reason: "System locked: max drawdown reached" };
    }
    throw err;
  }

  if (await checkCooldown()) {
    return {
      skip: true,
      reason: "Cooldown active: last trade was less than 2 hours ago",
    };
  }

  return { skip: false };
}
