import type { TradingMode } from "@/trading/strategy-config";

export function readRequiredRolloutMode(
  request: Request,
): TradingMode | undefined {
  const value = request.headers.get("x-required-rollout-mode");
  if (value === null) return undefined;
  const normalized = value.toLowerCase();
  if (
    normalized === "disabled" ||
    normalized === "shadow" ||
    normalized === "paper"
  ) {
    return normalized;
  }
  throw new Error("Invalid x-required-rollout-mode header");
}
