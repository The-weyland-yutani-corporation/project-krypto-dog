import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  assertDatasetMayBeUsedForParameterSweep,
  evidenceEvaluationPlanSchema,
  loadEvidenceEvaluationPlan,
  renderEvidenceReportHtml,
  runEvidenceEvaluation,
  runEvidenceParameterSweepStub,
  serializeEvidenceReportJson,
} from "@/backtest/evidence-evaluation";
import {
  evidenceDatasetInputSchema,
  evidenceDatasetMaterializedSha256,
  importEvidenceCsv,
  importEvidenceJson,
  loadEvidenceDataset,
  parseEvidenceDataset,
  serializeEvidenceDataset,
} from "@/backtest/evidence-dataset";

const fixtureDirectory = join(
  process.cwd(),
  "tests",
  "fixtures",
  "evidence",
);

type EvidenceDatasetDraft = z.input<
  typeof evidenceDatasetInputSchema
>;
type EvidencePlanDraft = z.input<
  typeof evidenceEvaluationPlanSchema
>;

function rawDataset(): EvidenceDatasetDraft {
  return JSON.parse(
    readFileSync(join(fixtureDirectory, "eth-daily.json"), "utf8"),
  ) as EvidenceDatasetDraft;
}

function dataset() {
  return importEvidenceJson(
    readFileSync(join(fixtureDirectory, "eth-daily.json")),
  );
}

function plan() {
  return loadEvidenceEvaluationPlan(
    readFileSync(
      join(fixtureDirectory, "eth-daily-plan.json"),
      "utf8",
    ),
  );
}

function planForDataset(
  value: ReturnType<typeof dataset>,
  overrides: Partial<EvidencePlanDraft> = {},
) {
  return evidenceEvaluationPlanSchema.parse({
    ...plan(),
    datasetId: value.manifest.datasetId,
    datasetCanonicalContentSha256:
      value.manifest.canonicalContentSha256,
    datasetSourceFileSha256: value.manifest.sourceFileSha256,
    datasetMaterializedSha256:
      evidenceDatasetMaterializedSha256(value),
    ...overrides,
  });
}

function datasetFromPrices(
  datasetId: string,
  prices: number[],
  intervalSeconds: number,
  startTimestamp = "2026-01-01T00:00:00.000Z",
) {
  const startTime = Date.parse(startTimestamp);
  const observations = prices.map((priceUSD, index) => ({
    timestamp: new Date(
      startTime + index * intervalSeconds * 1000,
    ).toISOString(),
    priceUSD,
  }));
  const draft: EvidenceDatasetDraft = {
    schemaVersion: "1.0.0",
    manifest: {
      datasetId,
      assetPair: "ETH/USDC",
      source: {
        kind: "fixture",
        name: `${datasetId} engineering fixture`,
      },
      acquisitionWindow: {
        start: observations[0].timestamp,
        end: observations.at(-1)?.timestamp ?? observations[0].timestamp,
      },
      intendedRole: "validation",
      expectedIntervalSeconds: intervalSeconds,
    },
    observations,
    gaps: [],
    paperExecutions: [],
  };
  return importEvidenceJson(JSON.stringify(draft));
}

describe("Phase 2 evidence dataset import", () => {
  it("imports equivalent JSON and CSV into the same canonical content hash", () => {
    const jsonDataset = dataset();
    const csvDataset = importEvidenceCsv(
      readFileSync(join(fixtureDirectory, "eth-daily.csv")),
      JSON.parse(
        readFileSync(
          join(fixtureDirectory, "eth-daily-manifest.json"),
          "utf8",
        ),
      ) as unknown,
    );

    expect(jsonDataset.manifest.canonicalContentSha256).toBe(
      "7cbe494cfa6f4041e027c2ea0c6996c83acdc5613901e8bf3629ec8364df54a6",
    );
    expect(csvDataset.manifest.canonicalContentSha256).toBe(
      jsonDataset.manifest.canonicalContentSha256,
    );
    expect(jsonDataset.materialization.sourceFormat).toBe("json");
    expect(csvDataset.materialization.sourceFormat).toBe("csv");
    expect(csvDataset.manifest.sourceFileSha256).not.toBe(
      jsonDataset.manifest.sourceFileSha256,
    );
    expect(
      evidenceDatasetMaterializedSha256(csvDataset),
    ).not.toBe(evidenceDatasetMaterializedSha256(jsonDataset));
    expect(csvDataset.observations).toEqual(
      jsonDataset.observations,
    );
    expect(
      serializeEvidenceDataset(
        loadEvidenceDataset(serializeEvidenceDataset(jsonDataset)),
      ),
    ).toBe(serializeEvidenceDataset(jsonDataset));

    const jsonReport = runEvidenceEvaluation(
      jsonDataset,
      planForDataset(jsonDataset),
    );
    const csvReport = runEvidenceEvaluation(
      csvDataset,
      planForDataset(csvDataset),
    );
    expect(jsonReport.dataset.canonicalContentSha256).toBe(
      csvReport.dataset.canonicalContentSha256,
    );
    expect(jsonReport.plan.datasetSourceFileSha256).not.toBe(
      csvReport.plan.datasetSourceFileSha256,
    );
    expect(jsonReport.plan.canonicalSha256).not.toBe(
      csvReport.plan.canonicalSha256,
    );
  });

  it("rejects a CSV materialization that forges the JSON raw-source hash", () => {
    const jsonDataset = dataset();
    const csvDataset = importEvidenceCsv(
      readFileSync(join(fixtureDirectory, "eth-daily.csv")),
      JSON.parse(
        readFileSync(
          join(fixtureDirectory, "eth-daily-manifest.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const forgedCsvDataset = structuredClone(csvDataset);
    forgedCsvDataset.manifest.sourceFileSha256 =
      jsonDataset.manifest.sourceFileSha256;
    const parsedForgery = parseEvidenceDataset(forgedCsvDataset);
    const jsonBoundPlan = planForDataset(jsonDataset);

    expect(parsedForgery.manifest.canonicalContentSha256).toBe(
      jsonDataset.manifest.canonicalContentSha256,
    );
    expect(parsedForgery.manifest.sourceFileSha256).toBe(
      jsonBoundPlan.datasetSourceFileSha256,
    );
    expect(
      evidenceDatasetMaterializedSha256(parsedForgery),
    ).not.toBe(jsonBoundPlan.datasetMaterializedSha256);
    expect(() =>
      runEvidenceEvaluation(parsedForgery, jsonBoundPlan),
    ).toThrow(
      /datasetMaterializedSha256 does not match the deterministic serialized materialized dataset hash/,
    );
  });

  it("rejects tampering, invalid timestamps/order/values, undeclared gaps, and out-of-bounds executions", () => {
    const tampered = structuredClone(dataset());
    tampered.observations[0].priceUSD = 101;
    expect(() => parseEvidenceDataset(tampered)).toThrow(
      /canonical content hash mismatch/,
    );

    const noTimezone = structuredClone(rawDataset());
    noTimezone.observations[0].timestamp = "2026-01-01T00:00:00";
    expect(() => evidenceDatasetInputSchema.parse(noTimezone)).toThrow();

    const duplicate = structuredClone(rawDataset());
    duplicate.observations[1].timestamp =
      duplicate.observations[0].timestamp;
    expect(() => evidenceDatasetInputSchema.parse(duplicate)).toThrow(
      /strictly ascending without duplicates/,
    );

    const nonPositive = structuredClone(rawDataset());
    nonPositive.observations[2].priceUSD = 0;
    expect(() =>
      evidenceDatasetInputSchema.parse(nonPositive),
    ).toThrow();

    const nonFinite = structuredClone(rawDataset());
    nonFinite.observations[2].priceUSD = Number.POSITIVE_INFINITY;
    expect(() => evidenceDatasetInputSchema.parse(nonFinite)).toThrow();

    const undeclaredGap = structuredClone(rawDataset());
    undeclaredGap.gaps = [];
    expect(() =>
      evidenceDatasetInputSchema.parse(undeclaredGap),
    ).toThrow(/require an explicit gap declaration/);

    const adjacentGaps = structuredClone(rawDataset());
    adjacentGaps.manifest.acquisitionWindow.end =
      "2026-01-05T00:00:00.000Z";
    adjacentGaps.observations = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        priceUSD: 100,
      },
      {
        timestamp: "2026-01-03T00:00:00.000Z",
        priceUSD: 95,
      },
      {
        timestamp: "2026-01-05T00:00:00.000Z",
        priceUSD: 90,
      },
    ];
    adjacentGaps.gaps = [
      {
        afterTimestamp: "2026-01-01T00:00:00.000Z",
        beforeTimestamp: "2026-01-03T00:00:00.000Z",
        reason: "Missing January 2.",
      },
      {
        afterTimestamp: "2026-01-03T00:00:00.000Z",
        beforeTimestamp: "2026-01-05T00:00:00.000Z",
        reason: "Missing January 4.",
      },
    ];
    adjacentGaps.paperExecutions = [];
    expect(
      evidenceDatasetInputSchema.parse(adjacentGaps).gaps,
    ).toHaveLength(2);

    const executionOutsideBounds = structuredClone(rawDataset());
    executionOutsideBounds.paperExecutions![0].timestamp =
      "2025-12-31T00:00:00.000Z";
    expect(() =>
      evidenceDatasetInputSchema.parse(executionOutsideBounds),
    ).toThrow(/within the acquisition and observation bounds/);
  });
});

describe("walk-forward evidence evaluation", () => {
  it("is byte-reproducible and reports deterministic version/provenance metadata", () => {
    const evidenceDataset = dataset();
    const evaluationPlan = plan();
    const first = runEvidenceEvaluation(
      evidenceDataset,
      evaluationPlan,
    );
    const second = runEvidenceEvaluation(
      evidenceDataset,
      evaluationPlan,
    );

    expect(serializeEvidenceReportJson(first)).toBe(
      serializeEvidenceReportJson(second),
    );
    expect(renderEvidenceReportHtml(first)).toBe(
      renderEvidenceReportHtml(second),
    );
    expect(first.codeVersion).toBe("align-backtesting-v1");
    expect(first.reportSchemaVersion).toBe("1.0.0");
    expect(first.plan.implementationCommitSha).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(first.plan.datasetSourceFileSha256).toBe(
      evidenceDataset.manifest.sourceFileSha256,
    );
    expect(first.plan.datasetMaterializedSha256).toBe(
      evidenceDatasetMaterializedSha256(evidenceDataset),
    );
    expect(first.dataset.materializedSha256).toBe(
      first.plan.datasetMaterializedSha256,
    );
    expect(first.dataset.sourceFormat).toBe("json");
    expect(first.versions.implementationCommitSha).toBe(
      first.plan.implementationCommitSha,
    );
    expect(first.eligibility).toEqual({
      classification: "engineering-only",
      releaseGateEligible: false,
      reasons: expect.arrayContaining([
        expect.stringMatching(/isolated fresh backtest state/),
        expect.stringMatching(/operator-declared/),
        expect.stringMatching(
          /Source metadata and sourceFileSha256 are importer\/operator-declared/,
        ),
        expect.stringMatching(/AgentRun and TradeExecution/),
      ]),
    });
    expect(first.provenance.sourceDeclaration).toEqual({
      classification: "importer/operator-declared",
      independentlyVerified: false,
      rawSourceBytesRetainedByReport: false,
      statement: expect.stringMatching(
        /cannot independently recompute the raw-source hash or authenticate the claimed source/,
      ),
    });
    expect(first.provenance.planAttestation).toEqual(
      expect.objectContaining({
        classification: "operator-declared",
        immutable: false,
        cryptographicallyAttested: false,
      }),
    );
    expect(first.versions.configurationVersion).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(first.versions.costModelVersion).toBe(
      "paper-execution-v1:fee-30bps:slippage-15bps",
    );
    expect(first.plan.canonicalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      first.provenance.externalPaperExecutions.usedForSimulation,
    ).toBe(false);
    expect(serializeEvidenceReportJson(first)).not.toContain(
      "generatedAt",
    );
    expect(renderEvidenceReportHtml(first)).toContain(
      first.plan.implementationCommitSha,
    );
    expect(renderEvidenceReportHtml(first)).toContain(
      first.plan.datasetMaterializedSha256,
    );
    expect(renderEvidenceReportHtml(first)).toContain(
      "Evidence classification: engineering-only",
    );
    expect(renderEvidenceReportHtml(first)).toContain(
      "Release-gate eligible:</strong> no",
    );
    expect(renderEvidenceReportHtml(first)).toContain(
      "Declared source-file SHA-256",
    );
    expect(renderEvidenceReportHtml(first)).toContain(
      "importer/operator-declared",
    );
    const differentCommitReport = runEvidenceEvaluation(
      evidenceDataset,
      planForDataset(evidenceDataset, {
        implementationCommitSha:
          "fedcba9876543210fedcba9876543210fedcba98",
      }),
    );
    expect(differentCommitReport.plan.canonicalSha256).not.toBe(
      first.plan.canonicalSha256,
    );
  });

  it("isolates every window from observations and execution provenance outside it", () => {
    const originalDataset = dataset();
    const originalReport = runEvidenceEvaluation(
      originalDataset,
      plan(),
    );
    const changedDraft = structuredClone(rawDataset());
    changedDraft.observations[0].priceUSD = 500;
    changedDraft.observations[1].priceUSD = 450;
    changedDraft.observations[2].priceUSD = 400;
    changedDraft.observations[3].priceUSD = 350;
    changedDraft.paperExecutions = [];
    const changedDataset = importEvidenceJson(
      JSON.stringify(changedDraft),
    );
    const changedReport = runEvidenceEvaluation(
      changedDataset,
      planForDataset(changedDataset),
    );

    expect(originalReport.windows[1].result).toEqual(
      changedReport.windows[1].result,
    );
    expect(
      originalReport.windows[1].result.equitySnapshots.map(
        (snapshot) => snapshot.timestamp,
      ),
    ).toEqual([
      "2026-01-06T00:00:00.000Z",
      "2026-01-07T00:00:00.000Z",
      "2026-01-08T00:00:00.000Z",
      "2026-01-09T00:00:00.000Z",
    ]);
    expect(
      originalReport.windows[1].result.trades.some(
        (trade) => trade.timestamp < originalReport.windows[1].start,
      ),
    ).toBe(false);
  });

  it("requires ordered non-overlapping exact observation windows and accounts for declared gaps", () => {
    const evidenceDataset = dataset();
    const overlapping: EvidencePlanDraft = {
      ...plan(),
      windows: [
        {
          windowId: "first",
          start: "2026-01-01T00:00:00.000Z",
          end: "2026-01-04T00:00:00.000Z",
        },
        {
          windowId: "overlap",
          start: "2026-01-04T00:00:00.000Z",
          end: "2026-01-06T00:00:00.000Z",
        },
      ],
    };
    expect(() =>
      evidenceEvaluationPlanSchema.parse(overlapping),
    ).toThrow(/ordered and non-overlapping/);

    const nonBoundary = planForDataset(evidenceDataset, {
      windows: [
        {
          windowId: "non-boundary",
          start: "2026-01-01T12:00:00.000Z",
          end: "2026-01-04T00:00:00.000Z",
        },
      ],
    });
    expect(() =>
      runEvidenceEvaluation(evidenceDataset, nonBoundary),
    ).toThrow(/exactly match observation timestamps/);

    const versionMismatch = planForDataset(evidenceDataset, {
      expectedVersions: {
        ...plan().expectedVersions,
        codeVersion: "different-code-version",
      },
    });
    expect(() =>
      runEvidenceEvaluation(evidenceDataset, versionMismatch),
    ).toThrow(/expectedVersions do not match/);

    const sourceHashMismatch = evidenceEvaluationPlanSchema.parse({
      ...planForDataset(evidenceDataset),
      datasetSourceFileSha256:
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    });
    expect(() =>
      runEvidenceEvaluation(evidenceDataset, sourceHashMismatch),
    ).toThrow(
      /datasetSourceFileSha256 does not match the validated dataset source-file hash/,
    );

    const fullWindow = planForDataset(evidenceDataset, {
      planId: "full-window-plan",
      windows: [
        {
          windowId: "full-window",
          start: "2026-01-01T00:00:00.000Z",
          end: "2026-01-09T00:00:00.000Z",
        },
      ],
    });
    const report = runEvidenceEvaluation(
      evidenceDataset,
      fullWindow,
    );
    expect(report.windows[0].declaredGaps).toEqual(
      evidenceDataset.gaps,
    );
    expect(report.methodology.gapHandling).toMatch(
      /Sharpe, Sortino, and Calmar are suppressed/,
    );
    expect(report.windows[0].result.metrics).toEqual(
      expect.objectContaining({
        sharpe: null,
        sortino: null,
        calmar: null,
      }),
    );
    expect(
      report.windows[0].riskMetricAvailability,
    ).toEqual(
      expect.objectContaining({
        dailySeriesComplete: false,
        continuityReason: expect.stringMatching(
          /explicitly declared data gaps/,
        ),
      }),
    );
  });

  it.each([
    ["equal to", "2026-01-01T00:00:00.000Z"],
    ["after", "2026-01-01T00:00:00.001Z"],
  ])(
    "rejects a declaredAt timestamp %s the first window start",
    (_description, declaredAt) => {
      expect(() =>
        evidenceEvaluationPlanSchema.parse({
          ...plan(),
          declaredAt,
        }),
      ).toThrow(
        /declaredAt must be strictly before the first evaluation-window start/,
      );
    },
  );

  it("requires an exact lowercase 40-hex implementation commit SHA", () => {
    expect(() =>
      evidenceEvaluationPlanSchema.parse({
        ...plan(),
        implementationCommitSha: "abc123",
      }),
    ).toThrow(/exact 40-character lowercase Git commit SHA/);
    expect(() =>
      evidenceEvaluationPlanSchema.parse({
        ...plan(),
        implementationCommitSha:
          "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
      }),
    ).toThrow(/exact 40-character lowercase Git commit SHA/);
  });

  it("suppresses risk-adjusted ratios when cadence cannot produce a complete UTC daily series", () => {
    const irregularCadenceDataset = datasetFromPrices(
      "seven-hour-cadence",
      [100, 97, 94, 96, 99, 103],
      7 * 60 * 60,
    );
    const evaluationPlan = planForDataset(
      irregularCadenceDataset,
      {
        planId: "seven-hour-cadence-plan",
        windows: [
          {
            windowId: "full-window",
            start:
              irregularCadenceDataset.observations[0].timestamp,
            end:
              irregularCadenceDataset.observations.at(-1)
                ?.timestamp ??
              irregularCadenceDataset.observations[0].timestamp,
          },
        ],
      },
    );
    const window = runEvidenceEvaluation(
      irregularCadenceDataset,
      evaluationPlan,
    ).windows[0];

    expect(window.declaredGaps).toEqual([]);
    expect(window.result.metrics.sharpe).toBeNull();
    expect(window.result.metrics.sortino).toBeNull();
    expect(window.result.metrics.calmar).toBeNull();
    expect(window.riskMetricAvailability).toEqual(
      expect.objectContaining({
        dailySeriesComplete: false,
        continuityReason: expect.stringMatching(
          /expected cadence of 25200 seconds cannot produce a complete UTC daily series/,
        ),
      }),
    );
  });

  it("suppresses risk-adjusted ratios for a partial first UTC day", () => {
    const partialFirstDayDataset = datasetFromPrices(
      "partial-first-day",
      [100, 99, 98, 97, 96, 95, 96, 97, 98, 99, 100],
      4 * 60 * 60,
      "2026-01-01T04:00:00.000Z",
    );
    const evaluationPlan = planForDataset(
      partialFirstDayDataset,
      {
        planId: "partial-first-day-plan",
        windows: [
          {
            windowId: "partial-first-day-window",
            start:
              partialFirstDayDataset.observations[0].timestamp,
            end:
              partialFirstDayDataset.observations.at(-1)
                ?.timestamp ??
              partialFirstDayDataset.observations[0].timestamp,
          },
        ],
      },
    );
    const window = runEvidenceEvaluation(
      partialFirstDayDataset,
      evaluationPlan,
    ).windows[0];

    expect(window.result.metrics.sharpe).toBeNull();
    expect(window.result.metrics.sortino).toBeNull();
    expect(window.result.metrics.calmar).toBeNull();
    expect(
      window.riskMetricAvailability.continuityReason,
    ).toMatch(/first UTC day is partial/);
  });

  it("retains and clearly renders unfavorable windows without filtering or reframing", () => {
    const report = runEvidenceEvaluation(dataset(), plan());
    const json = serializeEvidenceReportJson(report);
    const html = renderEvidenceReportHtml(report);

    expect(report.windows.map((window) => window.windowId)).toEqual([
      "drawdown-window",
      "uptrend-window",
    ]);
    expect(report.windows[0].result.metrics.netPnlUSD).toBeLessThan(0);
    expect(report.windows[0].result.beatsCash).toBe(false);
    expect(report.windows[1].result.beatsBuyHold).toBe(false);
    expect(report.summary).toEqual({
      windowCount: 2,
      beatsCash: 0,
      beatsBuyAndHold: 1,
      beatsBoth: 0,
      doesNotBeatCash: 2,
      doesNotBeatBuyAndHold: 1,
    });
    expect(json).toContain('"netPnlUSD": -6.401979000000011');
    expect(html).toContain("Did not beat cash");
    expect(html).toContain("Did not beat buy-and-hold");
    expect(html).toContain("Every predeclared result is reported");
  });

  it("never classifies a favorable imported slice as production release-gate evidence", () => {
    const favorableDataset = datasetFromPrices(
      "favorable-dip-recovery",
      [2100, 2065, 2025, 1960, 1900, 1955, 2020, 2085, 2150, 2210],
      4 * 60 * 60,
    );
    const evaluationPlan = planForDataset(favorableDataset, {
      planId: "favorable-slice-plan",
      windows: [
        {
          windowId: "favorable-slice",
          start: favorableDataset.observations[0].timestamp,
          end:
            favorableDataset.observations.at(-1)?.timestamp ??
            favorableDataset.observations[0].timestamp,
        },
      ],
    });
    const report = runEvidenceEvaluation(
      favorableDataset,
      evaluationPlan,
    );

    expect(report.windows[0].result.beatsCash).toBe(true);
    expect(
      report.windows[0].result.metrics.returnObservations,
    ).toBe(0);
    expect(report.windows[0].result.metrics.sharpe).toBeNull();
    expect(report.windows[0].result.metrics.sortino).toBeNull();
    expect(report.windows[0].result.metrics.calmar).toBeNull();
    expect(
      report.windows[0].riskMetricAvailability.continuityReason,
    ).toMatch(
      /final UTC day is partial.*daily close spacing is 16 hours rather than exactly 24 hours/,
    );
    expect(report.eligibility.classification).toBe(
      "engineering-only",
    );
    expect(report.eligibility.releaseGateEligible).toBe(false);
    expect(report.eligibility.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /favorable or arbitrarily selected slices/,
        ),
      ]),
    );
    expect(renderEvidenceReportHtml(report)).toContain(
      "Release-gate eligible:</strong> no",
    );
  });

  it("escapes source, plan, gap, and execution provenance in HTML", () => {
    const draft = structuredClone(rawDataset());
    draft.manifest.source.name = "<script>alert('source')</script>";
    draft.manifest.source.notes = "<b>source notes</b>";
    draft.gaps[0].reason = "<img src=x onerror=alert(1)>";
    draft.paperExecutions![0].sourceReference =
      "<svg onload=alert(2)>";
    const unsafeDataset = importEvidenceJson(JSON.stringify(draft));
    const unsafePlan = planForDataset(unsafeDataset, {
      declaredBy: "<operator>",
      notes: "<i>plan notes</i>",
      windows: [
        {
          windowId: "unsafe-window",
          start: "2026-01-01T00:00:00.000Z",
          end: "2026-01-09T00:00:00.000Z",
          notes: "<em>window notes</em>",
        },
      ],
    });
    const html = renderEvidenceReportHtml(
      runEvidenceEvaluation(unsafeDataset, unsafePlan),
    );

    expect(html).toContain(
      "&lt;script&gt;alert(&#39;source&#39;)&lt;/script&gt;",
    );
    expect(html).toContain(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<operator>");
    expect(html).toContain(":root { color-scheme: dark; }");
    expect(html).toContain("background: #05070a");
    expect(html).toContain("background: #0d1117");
    expect(html).toContain("color: #ef4444");
  });
});

describe("holdout tuning guard and CLI", () => {
  it("allows evaluation but rejects holdout tuning before the sweep stub", () => {
    const draft = structuredClone(rawDataset());
    draft.manifest.intendedRole = "holdout";
    const holdout = importEvidenceJson(JSON.stringify(draft));
    const report = runEvidenceEvaluation(
      holdout,
      planForDataset(holdout),
    );

    expect(report.dataset.intendedRole).toBe("holdout");
    expect(() =>
      assertDatasetMayBeUsedForParameterSweep(holdout),
    ).toThrow(/Holdout dataset .* cannot be used for tuning/);
    expect(() => runEvidenceParameterSweepStub(holdout)).toThrow(
      /Holdout dataset .* cannot be used for tuning/,
    );
    expect(() =>
      runEvidenceParameterSweepStub(dataset()),
    ).toThrow(/not implemented in the Phase 2 foundation/);
  });

  it("imports and evaluates fixtures through the package CLI scripts", () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "krypto-evidence-"),
    );
    const materializedPath = join(
      temporaryDirectory,
      "dataset.json",
    );
    const jsonReportPath = join(
      temporaryDirectory,
      "report.json",
    );
    const htmlReportPath = join(
      temporaryDirectory,
      "report.html",
    );
    try {
      execFileSync(
        "npm",
        [
          "run",
          "--silent",
          "evidence:import",
          "--",
          "--input",
          join(fixtureDirectory, "eth-daily.json"),
          "--out",
          materializedPath,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      execFileSync(
        "npm",
        [
          "run",
          "--silent",
          "evidence:evaluate",
          "--",
          "--dataset",
          materializedPath,
          "--plan",
          join(fixtureDirectory, "eth-daily-plan.json"),
          "--json-out",
          jsonReportPath,
          "--html-out",
          htmlReportPath,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      const report = JSON.parse(
        readFileSync(jsonReportPath, "utf8"),
      ) as { windows: unknown[] };
      expect(report.windows).toHaveLength(2);
      expect(readFileSync(htmlReportPath, "utf8")).toContain(
        "Walk-forward evidence report",
      );
    } finally {
      rmSync(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});
