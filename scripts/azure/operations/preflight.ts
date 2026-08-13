import { runCli } from "../lib/run-cli";
import type { AzureOperationContext, AzureOperationResult } from "./types";

/**
 * Runs the reviewed `deployment:preflight` CLI, explicitly requesting the
 * Azure provider (`--provider azure`) rather than relying on any default.
 * `DIRECT_URL`/`DATABASE_URL` continue to flow through the environment,
 * matching the existing `scripts/deployment-preflight.ts` contract; this
 * operation only adds the explicit provider selection.
 */
export async function run(
  context: AzureOperationContext,
): Promise<AzureOperationResult> {
  const result = await runCli(
    "npx",
    ["tsx", "scripts/deployment-preflight.ts", "--provider", "azure"],
    process.env,
  );

  let preflight: unknown;
  try {
    preflight = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `deployment:preflight did not return parseable JSON (exit code ${result.exitCode}).`,
    );
  }

  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new Error(
      `deployment:preflight failed with exit code ${result.exitCode}.`,
    );
  }

  return {
    passed: result.exitCode === 0,
    report: {
      operation: "preflight",
      provider: "azure",
      environmentName: context.environmentName,
      releaseSha: context.releaseSha,
      preflight,
    },
  };
}
