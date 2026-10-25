import { z } from "zod/v4";
import { canonicalSha256, stablePrettyJson } from "./canonical";
import {
  type EvidenceDataset,
  type EvidenceGap,
  type ExternalPaperExecution,
  evidenceDatasetMaterializedSha256,
  evidenceTimestampSchema,
  parseEvidenceDataset,
} from "./evidence-dataset";
import {
  BACKTEST_CODE_VERSION,
  BACKTEST_REPORT_SCHEMA_VERSION,
  runBacktestObservations,
} from "./runner";
import type {
  BacktestDecisionSource,
  BacktestResult,
} from "./types";

export const EVIDENCE_EVALUATION_PLAN_SCHEMA_VERSION = "1.0.0";
export const EVIDENCE_REPORT_SCHEMA_VERSION = "1.0.0";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must start with an alphanumeric character and contain only letters, numbers, ., _, :, or -",
  );

const implementationCommitShaSchema = z
  .string()
  .regex(
    /^[a-f0-9]{40}$/,
    "must be an exact 40-character lowercase Git commit SHA",
  );

const sha256Schema = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    "must be a lowercase SHA-256 hex digest",
  );

const evaluationWindowSchema = z
  .object({
    windowId: identifierSchema,
    start: evidenceTimestampSchema,
    end: evidenceTimestampSchema,
    notes: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((window, ctx) => {
    if (Date.parse(window.start) >= Date.parse(window.end)) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "evaluation window end must be after start",
      });
    }
  });

const expectedVersionsSchema = z
  .object({
    strategyVersion: z.string().trim().min(1).max(200),
    configurationVersion: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/),
    costModelVersion: z.string().trim().min(1).max(300),
    costModel: z
      .object({
        feeBps: z.number().int().nonnegative(),
        paperSlippageBps: z.number().int().nonnegative(),
      })
      .strict(),
    codeVersion: z.string().trim().min(1).max(200),
    backtestReportSchemaVersion: z.string().trim().min(1).max(100),
    evidenceReportSchemaVersion: z.string().trim().min(1).max(100),
  })
  .strict();

export const evidenceEvaluationPlanSchema = z
  .object({
    schemaVersion: z.literal(
      EVIDENCE_EVALUATION_PLAN_SCHEMA_VERSION,
    ),
    planId: identifierSchema,
    datasetId: identifierSchema,
    datasetCanonicalContentSha256: sha256Schema,
    datasetSourceFileSha256: sha256Schema,
    datasetMaterializedSha256: sha256Schema,
    declaredAt: evidenceTimestampSchema,
    implementationCommitSha: implementationCommitShaSchema,
    declaredBy: z.string().trim().min(1).max(500).optional(),
    notes: z.string().trim().min(1).max(4000).optional(),
    policy: z.enum(["rules-basic", "always-hold"]),
    llmCostUSD: z.number().finite().nonnegative().optional(),
    expectedVersions: expectedVersionsSchema,
    windows: z.array(evaluationWindowSchema).min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (
      Date.parse(plan.declaredAt) >=
      Date.parse(plan.windows[0].start)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["declaredAt"],
        message:
          "declaredAt must be strictly before the first evaluation-window start",
      });
    }
    const windowIds = new Set<string>();
    let previousEnd = -Infinity;
    for (let index = 0; index < plan.windows.length; index++) {
      const window = plan.windows[index];
      if (windowIds.has(window.windowId)) {
        ctx.addIssue({
          code: "custom",
          path: ["windows", index, "windowId"],
          message: "windowId values must be unique",
        });
      }
      windowIds.add(window.windowId);
      const start = Date.parse(window.start);
      if (start <= previousEnd) {
        ctx.addIssue({
          code: "custom",
          path: ["windows", index, "start"],
          message:
            "evaluation windows must be ordered and non-overlapping",
        });
      }
      previousEnd = Date.parse(window.end);
    }
  });

export type EvidenceEvaluationPlan = z.output<
  typeof evidenceEvaluationPlanSchema
>;

export interface EvidenceComparison {
  baselineUSD: number;
  differenceUSD: number;
  differencePct: number;
  outperformed: boolean;
}

export interface EvidenceMetricAvailability {
  available: boolean;
  reason: string | null;
}

export interface EvidenceRiskMetricAvailability {
  dailySeriesComplete: boolean;
  continuityReason: string | null;
  sharpe: EvidenceMetricAvailability;
  sortino: EvidenceMetricAvailability;
  calmar: EvidenceMetricAvailability;
}

export interface EvidenceWindowReport {
  windowId: string;
  start: string;
  end: string;
  notes: string | null;
  observationCount: number;
  declaredGaps: EvidenceGap[];
  comparisons: {
    cash: EvidenceComparison;
    buyAndHold: EvidenceComparison;
  };
  riskMetricAvailability: EvidenceRiskMetricAvailability;
  result: BacktestResult;
}

export interface EvidenceReport {
  reportSchemaVersion: string;
  reportType: "walk-forward-evaluation";
  codeVersion: string;
  eligibility: {
    classification: "engineering-only";
    releaseGateEligible: false;
    reasons: string[];
  };
  dataset: {
    schemaVersion: string;
    datasetId: string;
    canonicalContentSha256: string;
    sourceFileSha256: string;
    materializedSha256: string;
    sourceFormat: EvidenceDataset["materialization"]["sourceFormat"];
    intendedRole: EvidenceDataset["manifest"]["intendedRole"];
    assetPair: "ETH/USDC";
    expectedIntervalSeconds: number;
    acquisitionWindow: EvidenceDataset["manifest"]["acquisitionWindow"];
    observationCount: number;
  };
  plan: {
    schemaVersion: string;
    planId: string;
    canonicalSha256: string;
    datasetSourceFileSha256: string;
    datasetMaterializedSha256: string;
    declaredAt: string;
    implementationCommitSha: string;
    declaredBy: string | null;
    notes: string | null;
    policy: BacktestDecisionSource;
    llmCostUSD: number | null;
    expectedVersions: EvidenceEvaluationPlan["expectedVersions"];
  };
  versions: {
    strategyVersion: string;
    configurationVersion: string;
    costModelVersion: string;
    costModel: BacktestResult["metadata"]["costModel"];
    codeVersion: string;
    implementationCommitSha: string;
    backtestReportSchemaVersion: string;
    evidenceReportSchemaVersion: string;
  };
  provenance: {
    source: EvidenceDataset["manifest"]["source"];
    sourceDeclaration: {
      classification: "importer/operator-declared";
      independentlyVerified: false;
      rawSourceBytesRetainedByReport: false;
      statement: string;
    };
    planAttestation: {
      classification: "operator-declared";
      immutable: false;
      cryptographicallyAttested: false;
      statement: string;
      externalBindingGuidance: string;
    };
    externalPaperExecutions: {
      count: number;
      usedForSimulation: false;
      statement: string;
      records: ExternalPaperExecution[];
    };
  };
  methodology: {
    windowIsolation: string;
    gapHandling: string;
    executionAlignment: string;
    resultSelection: string;
  };
  summary: {
    windowCount: number;
    beatsCash: number;
    beatsBuyAndHold: number;
    beatsBoth: number;
    doesNotBeatCash: number;
    doesNotBeatBuyAndHold: number;
  };
  disclaimers: string[];
  windows: EvidenceWindowReport[];
}

function parseEvaluationPlan(value: unknown): EvidenceEvaluationPlan {
  return evidenceEvaluationPlanSchema.parse(value);
}

export function loadEvidenceEvaluationPlan(
  source: string,
): EvidenceEvaluationPlan {
  return parseEvaluationPlan(JSON.parse(source));
}

function observationIndex(
  dataset: EvidenceDataset,
): Map<string, number> {
  return new Map(
    dataset.observations.map((observation, index) => [
      observation.timestamp,
      index,
    ]),
  );
}

function validatePlanBinding(
  dataset: EvidenceDataset,
  plan: EvidenceEvaluationPlan,
): void {
  if (plan.datasetId !== dataset.manifest.datasetId) {
    throw new Error(
      `Evaluation plan datasetId ${plan.datasetId} does not match dataset ${dataset.manifest.datasetId}`,
    );
  }
  if (
    plan.datasetCanonicalContentSha256 !==
    dataset.manifest.canonicalContentSha256
  ) {
    throw new Error(
      "Evaluation plan datasetCanonicalContentSha256 does not match the validated dataset",
    );
  }
  if (
    plan.datasetSourceFileSha256 !==
    dataset.manifest.sourceFileSha256
  ) {
    throw new Error(
      "Evaluation plan datasetSourceFileSha256 does not match the validated dataset source-file hash",
    );
  }
  const materializedSha256 =
    evidenceDatasetMaterializedSha256(dataset);
  if (plan.datasetMaterializedSha256 !== materializedSha256) {
    throw new Error(
      `Evaluation plan datasetMaterializedSha256 does not match the deterministic serialized materialized dataset hash ${materializedSha256}`,
    );
  }
  const indexes = observationIndex(dataset);
  const firstTimestamp = dataset.observations[0].timestamp;
  const lastTimestamp =
    dataset.observations[dataset.observations.length - 1].timestamp;
  for (const window of plan.windows) {
    if (
      Date.parse(window.start) < Date.parse(firstTimestamp) ||
      Date.parse(window.end) > Date.parse(lastTimestamp)
    ) {
      throw new Error(
        `Evaluation window ${window.windowId} is outside the acquisition and observation bounds`,
      );
    }
    const startIndex = indexes.get(window.start);
    const endIndex = indexes.get(window.end);
    if (startIndex === undefined || endIndex === undefined) {
      throw new Error(
        `Evaluation window ${window.windowId} boundaries must exactly match observation timestamps`,
      );
    }
    if (endIndex - startIndex + 1 < 2) {
      throw new Error(
        `Evaluation window ${window.windowId} requires at least two isolated observations`,
      );
    }
  }
}

function comparison(
  finalEquityUSD: number,
  baselineUSD: number,
): EvidenceComparison {
  return {
    baselineUSD,
    differenceUSD: finalEquityUSD - baselineUSD,
    differencePct: (finalEquityUSD / baselineUSD - 1) * 100,
    outperformed: finalEquityUSD > baselineUSD,
  };
}

function gapsForWindow(
  gaps: EvidenceGap[],
  start: string,
  end: string,
): EvidenceGap[] {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  return gaps.filter(
    (gap) =>
      Date.parse(gap.afterTimestamp) >= startTime &&
      Date.parse(gap.beforeTimestamp) <= endTime,
  );
}

const UTC_DAY_SECONDS = 24 * 60 * 60;
const UTC_DAY_MS = UTC_DAY_SECONDS * 1000;

function utcDayOffsetSeconds(timestamp: string): number {
  return (
    (Date.parse(timestamp) -
      Date.parse(`${timestamp.slice(0, 10)}T00:00:00.000Z`)) /
    1000
  );
}

function riskMetricContinuityReason(
  observations: EvidenceDataset["observations"],
  declaredGaps: EvidenceGap[],
  expectedIntervalSeconds: number,
): string | null {
  const reasons: string[] = [];
  if (declaredGaps.length > 0) {
    reasons.push(
      "the window contains one or more explicitly declared data gaps",
    );
  }
  if (
    expectedIntervalSeconds > UTC_DAY_SECONDS ||
    UTC_DAY_SECONDS % expectedIntervalSeconds !== 0
  ) {
    reasons.push(
      `the expected cadence of ${expectedIntervalSeconds} seconds cannot produce a complete UTC daily series`,
    );
  } else {
    const firstOffset = utcDayOffsetSeconds(
      observations[0].timestamp,
    );
    const expectedFinalOffset =
      UTC_DAY_SECONDS - expectedIntervalSeconds;
    const finalOffset = utcDayOffsetSeconds(
      observations[observations.length - 1].timestamp,
    );
    if (firstOffset !== 0) {
      reasons.push(
        `the first UTC day is partial because the first observation is ${firstOffset} seconds after 00:00:00Z`,
      );
    }
    if (finalOffset !== expectedFinalOffset) {
      reasons.push(
        `the final UTC day is partial because the final observation is ${finalOffset} seconds after 00:00:00Z instead of the expected ${expectedFinalOffset} seconds`,
      );
    }
  }
  const dailyCloses = new Map<string, number>();
  for (const observation of observations) {
    dailyCloses.set(
      observation.timestamp.slice(0, 10),
      Date.parse(observation.timestamp),
    );
  }
  const dailyCloseTimes = [...dailyCloses.values()];
  for (let index = 1; index < dailyCloseTimes.length; index++) {
    const elapsedMs =
      dailyCloseTimes[index] - dailyCloseTimes[index - 1];
    if (elapsedMs !== UTC_DAY_MS) {
      reasons.push(
        `daily close spacing is ${elapsedMs / (60 * 60 * 1000)} hours rather than exactly 24 hours`,
      );
      break;
    }
  }
  return reasons.length === 0
    ? null
    : `Risk-adjusted ratios are suppressed because ${reasons.join(
        "; ",
      )}.`;
}

function suppressRiskAdjustedRatios(
  result: BacktestResult,
  continuityReason: string | null,
): BacktestResult {
  if (continuityReason === null) return result;
  return {
    ...result,
    metrics: {
      ...result.metrics,
      sharpe: null,
      sortino: null,
      calmar: null,
    },
  };
}

function metricAvailability(
  value: number | null,
  continuityReason: string | null,
  unavailableReason: string,
): EvidenceMetricAvailability {
  if (continuityReason !== null) {
    return { available: false, reason: continuityReason };
  }
  return value === null
    ? { available: false, reason: unavailableReason }
    : { available: true, reason: null };
}

function riskMetricAvailability(
  result: BacktestResult,
  continuityReason: string | null,
): EvidenceRiskMetricAvailability {
  return {
    dailySeriesComplete: continuityReason === null,
    continuityReason,
    sharpe: metricAvailability(
      result.metrics.sharpe,
      continuityReason,
      "Sharpe is unavailable because there are fewer than two consecutive UTC daily returns or their sample variance is zero.",
    ),
    sortino: metricAvailability(
      result.metrics.sortino,
      continuityReason,
      "Sortino is unavailable because there are no consecutive UTC daily returns with non-zero downside deviation.",
    ),
    calmar: metricAvailability(
      result.metrics.calmar,
      continuityReason,
      "Calmar is unavailable because the window duration, annualized return, or maximum drawdown denominator is insufficient.",
    ),
  };
}

function sameVersionMetadata(
  first: BacktestResult,
  current: BacktestResult,
): boolean {
  return (
    current.metadata.strategyVersion ===
      first.metadata.strategyVersion &&
    current.metadata.configurationVersion ===
      first.metadata.configurationVersion &&
    current.metadata.costModelVersion ===
      first.metadata.costModelVersion &&
    current.metadata.codeVersion === first.metadata.codeVersion &&
    current.metadata.reportSchemaVersion ===
      first.metadata.reportSchemaVersion &&
    current.metadata.costModel.feeBps ===
      first.metadata.costModel.feeBps &&
    current.metadata.costModel.paperSlippageBps ===
      first.metadata.costModel.paperSlippageBps
  );
}

function validateExpectedVersions(
  plan: EvidenceEvaluationPlan,
  result: BacktestResult,
): void {
  const actual = {
    strategyVersion: result.metadata.strategyVersion,
    configurationVersion: result.metadata.configurationVersion,
    costModelVersion: result.metadata.costModelVersion,
    costModel: result.metadata.costModel,
    codeVersion: result.metadata.codeVersion,
    backtestReportSchemaVersion:
      result.metadata.reportSchemaVersion,
    evidenceReportSchemaVersion: EVIDENCE_REPORT_SCHEMA_VERSION,
  };
  if (
    stablePrettyJson(actual) !==
    stablePrettyJson(plan.expectedVersions)
  ) {
    throw new Error(
      `Evaluation plan expectedVersions do not match the active production-aligned backtest metadata; expected ${JSON.stringify(plan.expectedVersions)}, actual ${JSON.stringify(actual)}`,
    );
  }
}

export function runEvidenceEvaluation(
  datasetValue: EvidenceDataset,
  planValue: EvidenceEvaluationPlan,
): EvidenceReport {
  const dataset = parseEvidenceDataset(datasetValue);
  const plan = parseEvaluationPlan(planValue);
  validatePlanBinding(dataset, plan);
  const indexes = observationIndex(dataset);
  const windows = plan.windows.map((window): EvidenceWindowReport => {
    const startIndex = indexes.get(window.start);
    const endIndex = indexes.get(window.end);
    if (startIndex === undefined || endIndex === undefined) {
      throw new Error(
        `Evaluation window ${window.windowId} lost its validated observation boundaries`,
      );
    }
    const observations = dataset.observations.slice(
      startIndex,
      endIndex + 1,
    );
    const declaredGaps = gapsForWindow(
      dataset.gaps,
      window.start,
      window.end,
    );
    const rawResult = runBacktestObservations(
      {
        name: `${dataset.manifest.datasetId}:${window.windowId}`,
        datasetId: dataset.manifest.datasetId,
        observations: observations.map((observation) => ({
          timestamp: observation.timestamp,
          price: observation.priceUSD,
        })),
        policy: plan.policy,
      },
      {
        policy: plan.policy,
        llmCostUSD: plan.llmCostUSD,
      },
    );
    const continuityReason = riskMetricContinuityReason(
      observations,
      declaredGaps,
      dataset.manifest.expectedIntervalSeconds,
    );
    const result = suppressRiskAdjustedRatios(
      rawResult,
      continuityReason,
    );
    return {
      windowId: window.windowId,
      start: window.start,
      end: window.end,
      notes: window.notes ?? null,
      observationCount: observations.length,
      declaredGaps,
      comparisons: {
        cash: comparison(
          result.finalEquityUSD,
          result.cashBaselineUSD,
        ),
        buyAndHold: comparison(
          result.finalEquityUSD,
          result.buyHoldEquityUSD,
        ),
      },
      riskMetricAvailability: riskMetricAvailability(
        result,
        continuityReason,
      ),
      result,
    };
  });
  const firstResult = windows[0].result;
  validateExpectedVersions(plan, firstResult);
  for (const window of windows.slice(1)) {
    if (!sameVersionMetadata(firstResult, window.result)) {
      throw new Error(
        `Evaluation window ${window.windowId} produced inconsistent strategy, configuration, cost, code, or schema metadata`,
      );
    }
  }

  return {
    reportSchemaVersion: EVIDENCE_REPORT_SCHEMA_VERSION,
    reportType: "walk-forward-evaluation",
    codeVersion: BACKTEST_CODE_VERSION,
    eligibility: {
      classification: "engineering-only",
      releaseGateEligible: false,
      reasons: [
        "Each imported window starts from isolated fresh backtest state rather than continuous production account state.",
        "The plan declaration timestamp and implementation commit SHA are operator-declared, not immutable, and not cryptographically attested by the standalone evaluator.",
        "Source metadata and sourceFileSha256 are importer/operator-declared because the materialized report does not retain raw source bytes for independent recomputation or authenticity verification.",
        "Imported files do not prove continuous production AgentRun and TradeExecution history, reconciliation, or scheduled-run completeness.",
        "File-based windows, including favorable or arbitrarily selected slices, cannot satisfy v2.2 or v3 production release gates.",
      ],
    },
    dataset: {
      schemaVersion: dataset.schemaVersion,
      datasetId: dataset.manifest.datasetId,
      canonicalContentSha256:
        dataset.manifest.canonicalContentSha256,
      sourceFileSha256: dataset.manifest.sourceFileSha256,
      materializedSha256:
        evidenceDatasetMaterializedSha256(dataset),
      sourceFormat: dataset.materialization.sourceFormat,
      intendedRole: dataset.manifest.intendedRole,
      assetPair: dataset.manifest.assetPair,
      expectedIntervalSeconds:
        dataset.manifest.expectedIntervalSeconds,
      acquisitionWindow: dataset.manifest.acquisitionWindow,
      observationCount: dataset.observations.length,
    },
    plan: {
      schemaVersion: plan.schemaVersion,
      planId: plan.planId,
      canonicalSha256: canonicalSha256(plan),
      datasetSourceFileSha256: plan.datasetSourceFileSha256,
      datasetMaterializedSha256:
        plan.datasetMaterializedSha256,
      declaredAt: plan.declaredAt,
      implementationCommitSha: plan.implementationCommitSha,
      declaredBy: plan.declaredBy ?? null,
      notes: plan.notes ?? null,
      policy: plan.policy,
      llmCostUSD: plan.llmCostUSD ?? null,
      expectedVersions: plan.expectedVersions,
    },
    versions: {
      strategyVersion: firstResult.metadata.strategyVersion,
      configurationVersion:
        firstResult.metadata.configurationVersion,
      costModelVersion: firstResult.metadata.costModelVersion,
      costModel: firstResult.metadata.costModel,
      codeVersion: firstResult.metadata.codeVersion,
      implementationCommitSha: plan.implementationCommitSha,
      backtestReportSchemaVersion:
        BACKTEST_REPORT_SCHEMA_VERSION,
      evidenceReportSchemaVersion:
        EVIDENCE_REPORT_SCHEMA_VERSION,
    },
    provenance: {
      source: dataset.manifest.source,
      sourceDeclaration: {
        classification: "importer/operator-declared",
        independentlyVerified: false,
        rawSourceBytesRetainedByReport: false,
        statement:
          "Source metadata and sourceFileSha256 were recorded during import or supplied by the operator. Evaluation receives the materialized dataset without the original raw bytes, so it cannot independently recompute the raw-source hash or authenticate the claimed source. The materialized hash binds these declarations to the plan but does not prove raw-source authenticity.",
      },
      planAttestation: {
        classification: "operator-declared",
        immutable: false,
        cryptographicallyAttested: false,
        statement:
          "declaredAt and implementationCommitSha are operator-supplied provenance. The standalone evaluator validates their format and ordering but does not prove when they were recorded or cryptographically bind them to the executing checkout.",
        externalBindingGuidance:
          "A GitHub Actions artifact may gain an external commit binding from workflow and artifact metadata such as github.sha; that external metadata is not created or verified by this standalone evaluator.",
      },
      externalPaperExecutions: {
        count: dataset.paperExecutions.length,
        usedForSimulation: false,
        statement:
          "Externally supplied paper executions are retained as provenance only and are not replayed, mutated, or used to emulate production execution.",
        records: dataset.paperExecutions,
      },
    },
    methodology: {
      windowIsolation:
        "Each predeclared window is sliced exactly from its start observation through its end observation, starts from fresh backtest state, and receives no observations or warmup state from outside the window.",
      gapHandling:
        "The importer rejects undeclared cadence gaps. Declared gaps remain visible, and Sharpe, Sortino, and Calmar are suppressed whenever a window has a declared gap, a partial first or final UTC day, a cadence that cannot produce complete UTC days, or daily closes that are not exactly 24 hours apart.",
      executionAlignment:
        "Every window uses the production-aligned backtest runner, production policy authorization, fixed-point accounting, production fee defaults, and paper-execution slippage model.",
      resultSelection:
        "All predeclared windows are included in order. Unfavorable windows and metrics are not removed, filtered, or reframed.",
    },
    summary: {
      windowCount: windows.length,
      beatsCash: windows.filter(
        (window) => window.result.beatsCash,
      ).length,
      beatsBuyAndHold: windows.filter(
        (window) => window.result.beatsBuyHold,
      ).length,
      beatsBoth: windows.filter(
        (window) =>
          window.result.beatsCash && window.result.beatsBuyHold,
      ).length,
      doesNotBeatCash: windows.filter(
        (window) => !window.result.beatsCash,
      ).length,
      doesNotBeatBuyAndHold: windows.filter(
        (window) => !window.result.beatsBuyHold,
      ).length,
    },
    disclaimers: [
      "Engineering-only simulation; this imported report is not eligible for production release gates and cannot substitute for actual deployment or scheduled paper-run evidence.",
      "Simulated historical or externally supplied paper evidence does not guarantee future performance or positive expected value.",
      "Operator-declared plan timestamps and implementation commit SHAs are provenance claims, not immutable or cryptographic attestations from the standalone evaluator.",
      "Source metadata and sourceFileSha256 are importer/operator-declared; without retained raw bytes, the standalone evaluator cannot independently verify the raw-source hash or authenticity.",
      "Cash and buy-and-hold comparisons use the exact same isolated observation window as the strategy.",
      "External paper executions are provenance only and do not alter simulated balances, trades, fees, slippage, or policy decisions.",
      "Every predeclared result is reported, including losses, underperformance, null ratios, and other unfavorable outcomes.",
    ],
    windows,
  };
}

export function assertDatasetMayBeUsedForParameterSweep(
  datasetValue: EvidenceDataset,
): void {
  const dataset = parseEvidenceDataset(datasetValue);
  if (dataset.manifest.intendedRole === "holdout") {
    throw new Error(
      `Holdout dataset ${dataset.manifest.datasetId} cannot be used for tuning or a parameter sweep`,
    );
  }
}

export function runEvidenceParameterSweepStub(
  datasetValue: EvidenceDataset,
): never {
  assertDatasetMayBeUsedForParameterSweep(datasetValue);
  throw new Error(
    "Evidence parameter sweeps are not implemented in the Phase 2 foundation",
  );
}

export function serializeEvidenceReportJson(
  report: EvidenceReport,
): string {
  return stablePrettyJson(report);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function metric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

function outcome(outperformed: boolean, baseline: string): string {
  return outperformed
    ? `Beat ${baseline}`
    : `Did not beat ${baseline}`;
}

function optionalText(value: string | undefined): string {
  return value === undefined ? "n/a" : escapeHtml(value);
}

function renderExecutionRows(
  executions: ExternalPaperExecution[],
): string {
  if (executions.length === 0) {
    return '<p class="muted">No external paper executions supplied.</p>';
  }
  return `<table>
    <thead><tr><th>Timestamp</th><th>Side</th><th>Quantity ETH</th><th>Notional</th><th>Observed / execution</th><th>Fees / slippage</th><th>Reference</th></tr></thead>
    <tbody>${executions
      .map(
        (execution) => `<tr>
          <td>${escapeHtml(execution.timestamp)}</td>
          <td>${escapeHtml(execution.side)}</td>
          <td>${execution.quantityETH.toFixed(8)}</td>
          <td>${money(execution.notionalUSD)}</td>
          <td>${money(execution.observedPriceUSD)} / ${money(execution.executionPriceUSD)}</td>
          <td>${money(execution.feesUSD)} / ${money(execution.slippageUSD)}</td>
          <td>${optionalText(execution.sourceReference ?? execution.executionId)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function renderGapRows(gaps: EvidenceGap[]): string {
  if (gaps.length === 0) {
    return '<p class="muted">No declared gaps in this window.</p>';
  }
  return `<table>
    <thead><tr><th>After</th><th>Before</th><th>Reason</th></tr></thead>
    <tbody>${gaps
      .map(
        (gap) => `<tr>
          <td>${escapeHtml(gap.afterTimestamp)}</td>
          <td>${escapeHtml(gap.beforeTimestamp)}</td>
          <td>${escapeHtml(gap.reason)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function renderRiskMetricAvailability(
  availability: EvidenceRiskMetricAvailability,
): string {
  const entries: Array<
    [string, EvidenceMetricAvailability]
  > = [
    ["Sharpe", availability.sharpe],
    ["Sortino", availability.sortino],
    ["Calmar", availability.calmar],
  ];
  return `<ul>${entries
    .map(
      ([name, metricAvailability]) =>
        `<li><strong>${name}:</strong> ${
          metricAvailability.available
            ? "available"
            : `unavailable — ${escapeHtml(
                metricAvailability.reason ?? "no reason recorded",
              )}`
        }</li>`,
    )
    .join("")}</ul>`;
}

function renderWindow(window: EvidenceWindowReport): string {
  const result = window.result;
  const buyTrades = result.trades.filter(
    (trade) => trade.direction === "BUY",
  ).length;
  const sellTrades = result.trades.length - buyTrades;
  return `<section>
    <h2>${escapeHtml(window.windowId)}</h2>
    <p><strong>Window:</strong> ${escapeHtml(window.start)} through ${escapeHtml(window.end)} (${window.observationCount} observations)</p>
    <p><strong>Notes:</strong> ${window.notes === null ? "n/a" : escapeHtml(window.notes)}</p>
    <p class="${result.beatsCash ? "favorable" : "unfavorable"}"><strong>${outcome(result.beatsCash, "cash")}:</strong> final ${money(result.finalEquityUSD)}, cash ${money(result.cashBaselineUSD)}, difference ${money(window.comparisons.cash.differenceUSD)}</p>
    <p class="${result.beatsBuyHold ? "favorable" : "unfavorable"}"><strong>${outcome(result.beatsBuyHold, "buy-and-hold")}:</strong> final ${money(result.finalEquityUSD)}, buy-and-hold ${money(result.buyHoldEquityUSD)}, difference ${money(window.comparisons.buyAndHold.differenceUSD)}</p>
    <table>
      <tbody>
        <tr><th>Net PnL</th><td>${money(result.metrics.netPnlUSD)}</td><th>Max drawdown</th><td>${result.maxDrawdownPct.toFixed(4)}%</td></tr>
        <tr><th>Sharpe</th><td>${metric(result.metrics.sharpe)}</td><th>Sortino</th><td>${metric(result.metrics.sortino)}</td></tr>
        <tr><th>Calmar</th><td>${metric(result.metrics.calmar)}</td><th>Return observations</th><td>${result.metrics.returnObservations}</td></tr>
        <tr><th>Turnover</th><td>${metric(result.metrics.turnover)}</td><th>Fee efficiency</th><td>${metric(result.metrics.feeEfficiency)}</td></tr>
        <tr><th>Total fees</th><td>${money(result.totalFeesUSD)}</td><th>Modeled slippage</th><td>${money(result.metrics.totalModeledSlippageUSD)}</td></tr>
        <tr><th>Benchmark alpha</th><td>${result.metrics.benchmarkAlphaPct.toFixed(4)} pp</td><th>Trades</th><td>${result.trades.length} (${buyTrades} BUY / ${sellTrades} SELL)</td></tr>
        <tr><th>Locked</th><td>${result.locked ? "yes" : "no"}</td><th>Assertions</th><td>${result.assertionFailures.length === 0 ? "none" : escapeHtml(result.assertionFailures.join("; "))}</td></tr>
      </tbody>
    </table>
    <h3>Risk-metric availability</h3>
    ${renderRiskMetricAvailability(window.riskMetricAvailability)}
    <h3>Declared gaps</h3>
    ${renderGapRows(window.declaredGaps)}
  </section>`;
}

export function renderEvidenceReportHtml(
  report: EvidenceReport,
): string {
  const source = report.provenance.source;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Evidence report ${escapeHtml(report.plan.planId)}</title>
  <style>
    :root { color-scheme: dark; }
    body { background: #05070a; color: #cbd5e1; font-family: Inter, ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; }
    h1, h2, h3 { color: #f8fafc; }
    section { background: #0d1117; border: 1px solid #243044; border-radius: 12px; margin-top: 2rem; padding: 1rem; }
    table { background: #0d1117; border-collapse: collapse; font-variant-numeric: tabular-nums; margin: 0.75rem 0 1.25rem; width: 100%; }
    th, td { border: 1px solid #243044; padding: 0.5rem; text-align: left; vertical-align: top; }
    th { background: #111827; color: #e2e8f0; }
    .notice { background: #451a03; border: 1px solid #f59e0b; border-radius: 8px; color: #f8fafc; padding: 1rem; }
    .gate-ineligible { background: #450a0a; border: 2px solid #ef4444; border-radius: 8px; color: #f8fafc; margin: 1rem 0; padding: 1rem; }
    .gate-ineligible h2 { margin-top: 0; }
    .favorable { color: #22c55e; font-weight: 600; }
    .unfavorable { color: #ef4444; font-weight: 600; }
    .muted { color: #94a3b8; }
    code { color: #38bdf8; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <h1>Walk-forward evidence report</h1>
  <p><strong>Plan:</strong> ${escapeHtml(report.plan.planId)} | <strong>Dataset:</strong> ${escapeHtml(report.dataset.datasetId)} | <strong>Role:</strong> ${escapeHtml(report.dataset.intendedRole)}</p>
  <div class="gate-ineligible">
    <h2>Evidence classification: ${escapeHtml(report.eligibility.classification)}</h2>
    <p><strong>Release-gate eligible:</strong> ${report.eligibility.releaseGateEligible ? "yes" : "no"}</p>
    <ul>${report.eligibility.reasons
      .map((reason) => `<li>${escapeHtml(reason)}</li>`)
      .join("")}</ul>
  </div>
  <div class="notice">
    <strong>Engineering and simulation disclaimers</strong>
    <ul>${report.disclaimers
      .map((disclaimer) => `<li>${escapeHtml(disclaimer)}</li>`)
      .join("")}</ul>
  </div>

  <h2>Versions and configuration</h2>
  <table><tbody>
    <tr><th>Code version</th><td>${escapeHtml(report.versions.codeVersion)}</td><th>Evidence report schema</th><td>${escapeHtml(report.versions.evidenceReportSchemaVersion)}</td></tr>
    <tr><th>Operator-declared implementation commit SHA</th><td colspan="3"><code>${escapeHtml(report.versions.implementationCommitSha)}</code></td></tr>
    <tr><th>Backtest report schema</th><td>${escapeHtml(report.versions.backtestReportSchemaVersion)}</td><th>Strategy version</th><td>${escapeHtml(report.versions.strategyVersion)}</td></tr>
    <tr><th>Configuration version</th><td><code>${escapeHtml(report.versions.configurationVersion)}</code></td><th>Cost model version</th><td>${escapeHtml(report.versions.costModelVersion)}</td></tr>
    <tr><th>Fee / slippage</th><td>${report.versions.costModel.feeBps} bps / ${report.versions.costModel.paperSlippageBps} bps</td><th>Policy</th><td>${escapeHtml(report.plan.policy)}</td></tr>
  </tbody></table>

  <h2>Dataset and provenance</h2>
  <table><tbody>
    <tr><th>Evaluation-plan SHA-256</th><td colspan="3"><code>${escapeHtml(report.plan.canonicalSha256)}</code></td></tr>
    <tr><th>Canonical content SHA-256</th><td colspan="3"><code>${escapeHtml(report.dataset.canonicalContentSha256)}</code></td></tr>
    <tr><th>Declared source-file SHA-256</th><td colspan="3"><code>${escapeHtml(report.dataset.sourceFileSha256)}</code></td></tr>
    <tr><th>Plan-bound declared source-file SHA-256</th><td colspan="3"><code>${escapeHtml(report.plan.datasetSourceFileSha256)}</code></td></tr>
    <tr><th>Materialized dataset SHA-256</th><td colspan="3"><code>${escapeHtml(report.dataset.materializedSha256)}</code></td></tr>
    <tr><th>Plan-bound materialized SHA-256</th><td colspan="3"><code>${escapeHtml(report.plan.datasetMaterializedSha256)}</code></td></tr>
    <tr><th>Import format</th><td>${escapeHtml(report.dataset.sourceFormat)}</td><th>Asset pair</th><td>${escapeHtml(report.dataset.assetPair)}</td></tr>
    <tr><th>Declared source kind / name</th><td>${escapeHtml(source.kind)} / ${escapeHtml(source.name)}</td><th>Declared locator</th><td>${optionalText(source.locator)}</td></tr>
    <tr><th>Declared source notes</th><td colspan="3">${optionalText(source.notes)}</td></tr>
    <tr><th>Source verification</th><td colspan="3"><strong>${escapeHtml(report.provenance.sourceDeclaration.classification)}</strong>: ${escapeHtml(report.provenance.sourceDeclaration.statement)}</td></tr>
    <tr><th>Acquisition window</th><td>${escapeHtml(report.dataset.acquisitionWindow.start)} through ${escapeHtml(report.dataset.acquisitionWindow.end)}</td><th>Cadence / observations</th><td>${report.dataset.expectedIntervalSeconds}s / ${report.dataset.observationCount}</td></tr>
    <tr><th>Operator-declared by / at</th><td>${report.plan.declaredBy === null ? "n/a" : escapeHtml(report.plan.declaredBy)} / ${escapeHtml(report.plan.declaredAt)}</td><th>Plan notes</th><td>${report.plan.notes === null ? "n/a" : escapeHtml(report.plan.notes)}</td></tr>
    <tr><th>Plan/SHA attestation</th><td colspan="3">${escapeHtml(report.provenance.planAttestation.statement)} ${escapeHtml(report.provenance.planAttestation.externalBindingGuidance)}</td></tr>
  </tbody></table>

  <h2>Methodology</h2>
  <ul>
    <li>${escapeHtml(report.methodology.windowIsolation)}</li>
    <li>${escapeHtml(report.methodology.gapHandling)}</li>
    <li>${escapeHtml(report.methodology.executionAlignment)}</li>
    <li>${escapeHtml(report.methodology.resultSelection)}</li>
  </ul>

  <h2>All-window summary</h2>
  <p>${report.summary.windowCount} windows; ${report.summary.beatsCash} beat cash; ${report.summary.beatsBuyAndHold} beat buy-and-hold; ${report.summary.beatsBoth} beat both; ${report.summary.doesNotBeatCash} did not beat cash; ${report.summary.doesNotBeatBuyAndHold} did not beat buy-and-hold.</p>

  <h2>External paper executions (provenance only)</h2>
  <p>${escapeHtml(report.provenance.externalPaperExecutions.statement)}</p>
  ${renderExecutionRows(report.provenance.externalPaperExecutions.records)}

  ${report.windows.map(renderWindow).join("\n")}
</body>
</html>
`;
}
