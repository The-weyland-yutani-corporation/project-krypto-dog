import { resolveTradingMode } from "@/trading/strategy-config";

export interface HealthPayload {
  status: "ok";
  /** Effective deterministic rollout mode: disabled | shadow | paper. */
  rolloutMode: string;
  /** Harness mode when running under the local harness, otherwise null. */
  harnessMode: string | null;
}

/**
 * Build the minimal, non-sensitive health payload.
 *
 * It intentionally exposes only the effective rollout mode and (optional)
 * harness mode. It never reads secrets, connection strings, or database
 * internals, so it is safe to serve unauthenticated in every environment,
 * including production.
 */
export function buildHealthPayload(
  env: Record<string, string | undefined> = process.env,
): HealthPayload {
  const harnessMode = env.AGENT_HARNESS_MODE;
  return {
    status: "ok",
    rolloutMode: resolveTradingMode(env),
    harnessMode:
      harnessMode === "mock" || harnessMode === "smoke" ? harnessMode : null,
  };
}
