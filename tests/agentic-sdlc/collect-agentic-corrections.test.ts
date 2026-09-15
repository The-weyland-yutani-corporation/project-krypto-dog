/**
 * Staged CorrectionOps collector contract tests.
 *
 * These tests exercise the deterministic correction collector
 * (`scripts/agentic/collect-agentic-corrections.cjs`) entirely against synthetic
 * fixtures, hand-built prediction/truth inputs, and an injected `gh` runner. No
 * test contacts GitHub — every prediction/truth path is supplied directly (or
 * from committed on-disk fixtures) and the one CLI test that exercises the live
 * seam injects a fake runner, so "tests must not contact GitHub" holds by
 * construction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const collectorPath = path.join(
  root,
  "scripts",
  "agentic",
  "collect-agentic-corrections.cjs",
);

const c = jest.requireActual<CorrectionOps>(collectorPath);

const FIXTURES = path.join(
  root,
  "tests",
  "agentic-sdlc",
  "fixtures",
  "corrections",
);

type Runner = (
  command: string,
  args: string[],
) => { status: number; stdout: string; stderr: string };

interface CorrectionOps {
  REPORT_SCHEMA_VERSION: number;
  STATE_HASH_MARKER_PREFIX: string;
  MAX_RETAINED_RECORDS: number;
  PM_TRIAGE_RELEVANT_LABELS: string[];
  ROUTE_LABELS: string[];
  TRUSTED_PERMISSIONS: string[];
  parseJsonl(text: string, label?: string): unknown[];
  parseAwInfo(json: unknown): Record<string, unknown>;
  normalizeWorkflowId(value: unknown): string | null;
  computeInstructionHash(input: unknown): string;
  extractPmTriagePrediction(input: unknown): Record<string, unknown> | null;
  extractSpecialistRoutingPrediction(
    input: unknown,
  ): Record<string, unknown> | null;
  deriveImmutableRoutes(files: unknown, reconciler?: unknown): string[];
  isTrustedActor(actorType: unknown, permission: unknown): boolean;
  deriveLabelTruth(
    events: unknown,
    relevant: string[],
    afterIso: string | null,
  ): { acted: Set<string>; present: Set<string>; botExcluded: number; untrustedExcluded: number };
  diffPmTriageRecord(prediction: unknown, truth: unknown): Record<string, unknown>;
  diffRoutingRecord(prediction: unknown, truth: unknown): Record<string, unknown>;
  dedupeAndCap(records: unknown[], cap?: number): Array<Record<string, unknown>>;
  computeCorrectionRate(diffs: unknown[]): {
    match: number;
    mismatch: number;
    sampleSize: number;
    correctionRate: number | null;
  };
  buildReport(input: unknown): Record<string, any>;
  computeMaterialHash(report: unknown): string;
  readPublishedHash(issues: unknown): string | null;
  decideChange(input: unknown): {
    changed: boolean;
    cacheHit: boolean;
    publishedHash: string | null;
    delta: unknown;
  };
  readRunFolder(dir: string): Record<string, unknown> | null;
  firstItemNumber(outputs: unknown): number | null;
  runFixtureContract(dir: string): {
    report: Record<string, unknown>;
    drift: unknown;
    expectedExists: boolean;
  };
  collect(options: unknown): {
    report: Record<string, any>;
    decision: unknown;
    cacheRecord: Record<string, unknown>;
  };
  main(argv: string[], deps?: Record<string, unknown>): number;
}

function makeAwInfo(overrides: Record<string, unknown> = {}) {
  return c.parseAwInfo({
    workflow_name: "pm-triage",
    run_id: 999,
    head_sha: "deadbeef",
    model: "gpt-x",
    created_at: "2026-08-01T00:00:00Z",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Artifact parsing (incl. real-like safeoutputs shape)
// ---------------------------------------------------------------------------

describe("corrections — artifact parsing", () => {
  it("normalizes live display names and records the workflow version", () => {
    const info = c.parseAwInfo({
      workflow_name: "PM Triage",
      run_id: 123,
      model: "claude",
      version: "1.0.65",
    });
    expect(info.workflow).toBe("pm-triage");
    expect(info.workflowVersion).toBe("1.0.65");
  });

  it("parses a real-like PM-triage run folder into a prediction", () => {
    const raw = c.readRunFolder(
      path.join(FIXTURES, "runs", "pm-triage", "run-2001"),
    );
    expect(raw).not.toBeNull();
    const prediction = c.extractPmTriagePrediction(raw)!;
    expect(prediction.id).toBe("pm-triage:2001:131");
    expect(prediction.workflow).toBe("pm-triage");
    expect(prediction.runId).toBe("2001");
    expect(prediction.itemNumber).toBe(131);
    // Only relevant vocabulary is retained; structural agentic-factory is dropped.
    expect(prediction.predictedLabels).toEqual(["ready-for-planning"]);
    expect(prediction.predictedNoop).toBe(false);
    expect(prediction.appliedAt).toBe("2026-08-01T09:03:00Z");
    expect(typeof prediction.instructionHash).toBe("string");
    expect((prediction.instructionHash as string).length).toBe(64);
  });

  it("parses a real-like code-review run into a routing prediction with separate route sets", () => {
    const raw = c.readRunFolder(
      path.join(FIXTURES, "runs", "code-review", "run-3001"),
    );
    const prediction = c.extractSpecialistRoutingPrediction({
      ...raw,
      changedFiles: ["src/trading/exec.ts", "src/lib/util.ts"],
    })!;
    expect(prediction.kind).toBe("specialist-routing");
    expect(prediction.semanticPredictedRoutes).toEqual([
      "security",
      "trading-safety",
    ]);
    // Immutable route derives ONLY from the changed path (src/trading), never
    // from the model's semantic label choice.
    expect(prediction.immutableRoutes).toEqual(["trading-safety"]);
    // Path metadata count only — no filenames persisted.
    expect(prediction.changedFileCount).toBe(2);
    expect(prediction).not.toHaveProperty("changedFiles");
  });

  it("never stores comment/issue/prompt bodies in a prediction", () => {
    const raw = c.readRunFolder(
      path.join(FIXTURES, "runs", "pm-triage", "run-2001"),
    );
    const prediction = c.extractPmTriagePrediction(raw)!;
    const serialized = JSON.stringify(prediction);
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("Refine the issue");
  });

  it("retains a noop prediction whose item number comes from the noop output", () => {
    const prediction = c.extractPmTriagePrediction({
      awInfo: makeAwInfo(),
      safeOutputs: [{ type: "noop", item_number: 19 }],
      appliedItems: [],
      instructionHash: "IH",
    })!;
    expect(prediction.itemNumber).toBe(19);
    expect(prediction.predictedNoop).toBe(true);
    expect(prediction.appliedAt).toBe("2026-08-01T00:00:00Z");
  });

  it("finds the PR number even when code review requested no specialist label", () => {
    expect(
      c.firstItemNumber([
        { type: "create-check-run", item_number: 77 },
        { type: "add-comment", item_number: 77 },
      ]),
    ).toBe(77);
  });

  it("derives the instruction hash from the import tree + prompt deterministically", () => {
    const a = c.computeInstructionHash({
      importTree: { root: "x", imports: ["a"] },
      promptText: "hello",
    });
    const b = c.computeInstructionHash({
      importTree: { root: "x", imports: ["a"] },
      promptText: "hello",
    });
    const different = c.computeInstructionHash({
      importTree: { root: "x", imports: ["b"] },
      promptText: "hello",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(different);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSONL fail-loud
// ---------------------------------------------------------------------------

describe("corrections — JSONL parsing is fail-loud", () => {
  it("throws with file + line on a malformed JSONL line", () => {
    const text = '{"type":"add-labels"}\nnot-json\n';
    expect(() => c.parseJsonl(text, "safeoutputs.jsonl")).toThrow(
      /safeoutputs\.jsonl: malformed JSON on line 2/,
    );
  });

  it("tolerates a trailing newline but never a malformed line", () => {
    expect(c.parseJsonl('{"a":1}\n', "x")).toEqual([{ a: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Dedupe + cap
// ---------------------------------------------------------------------------

describe("corrections — dedupe and cap", () => {
  it("dedupes by stable id, keeping the newest createdAt", () => {
    const older = { id: "w:1:5", createdAt: "2026-08-01T00:00:00Z", v: "old" };
    const newer = { id: "w:1:5", createdAt: "2026-08-02T00:00:00Z", v: "new" };
    const result = c.dedupeAndCap([older, newer]);
    expect(result).toHaveLength(1);
    expect(result[0].v).toBe("new");
  });

  it("caps retained records to the newest N by createdAt", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: `w:${i}:1`,
      createdAt: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const capped = c.dedupeAndCap(records, 3);
    expect(capped).toHaveLength(3);
    // Newest three ids retained, returned in stable id order.
    expect(capped.map((r) => r.id)).toEqual(["w:7:1", "w:8:1", "w:9:1"]);
  });
});

// ---------------------------------------------------------------------------
// Trusted permission filtering + bot exclusion + pending truth
// ---------------------------------------------------------------------------

describe("corrections — trusted truth filtering", () => {
  const relevant = c.PM_TRIAGE_RELEVANT_LABELS;

  it("counts only User actors with admin/maintain/write permission", () => {
    expect(c.isTrustedActor("User", "admin")).toBe(true);
    expect(c.isTrustedActor("User", "maintain")).toBe(true);
    expect(c.isTrustedActor("User", "write")).toBe(true);
    expect(c.isTrustedActor("User", "read")).toBe(false);
    expect(c.isTrustedActor("User", "triage")).toBe(false);
    expect(c.isTrustedActor("Bot", "admin")).toBe(false);
  });

  it("excludes bot and untrusted-user events from scoring but counts them", () => {
    const events = [
      { label: "needs-qa", action: "labeled", actorType: "Bot", permission: null, createdAt: "2026-08-02T00:00:00Z" },
      { label: "docs-sync", action: "labeled", actorType: "User", permission: "read", createdAt: "2026-08-02T00:00:00Z" },
      { label: "ready-for-planning", action: "labeled", actorType: "User", permission: "write", createdAt: "2026-08-02T00:00:00Z" },
    ];
    const truth = c.deriveLabelTruth(events, relevant, "2026-08-01T00:00:00Z");
    expect([...truth.acted]).toEqual(["ready-for-planning"]);
    expect([...truth.present]).toEqual(["ready-for-planning"]);
    expect(truth.botExcluded).toBe(1);
    expect(truth.untrustedExcluded).toBe(1);
  });

  it("ignores events at or before the applied timestamp", () => {
    const events = [
      { label: "needs-qa", action: "labeled", actorType: "User", permission: "admin", createdAt: "2026-08-01T00:00:00Z" },
    ];
    const truth = c.deriveLabelTruth(events, relevant, "2026-08-01T00:00:00Z");
    expect([...truth.acted]).toEqual([]);
  });

  it("treats no trusted human action as pending, never a match", () => {
    const prediction = c.extractPmTriagePrediction({
      awInfo: makeAwInfo(),
      safeOutputs: [{ type: "add-labels", item_number: 7, labels: ["ready-for-planning"] }],
      appliedItems: [],
      instructionHash: "IH",
    })!;
    const truth = c.deriveLabelTruth([], relevant, null);
    const diff = c.diffPmTriageRecord(prediction, truth);
    expect(diff.status).toBe("pending");
    expect(diff.correction).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Add/remove truth diff semantics
// ---------------------------------------------------------------------------

describe("corrections — add/remove label truth diff", () => {
  it("scores a removed prediction + added label as a mismatch/correction", () => {
    const prediction = c.extractPmTriagePrediction({
      awInfo: makeAwInfo(),
      safeOutputs: [{ type: "add-labels", item_number: 7, labels: ["ready-for-planning"] }],
      appliedItems: [{ type: "add-labels", applied_at: "2026-08-01T01:00:00Z" }],
      instructionHash: "IH",
    })!;
    const truth = c.deriveLabelTruth(
      [
        { label: "ready-for-planning", action: "unlabeled", actorType: "User", permission: "admin", createdAt: "2026-08-02T00:00:00Z" },
        { label: "needs-qa", action: "labeled", actorType: "User", permission: "admin", createdAt: "2026-08-02T00:00:00Z" },
      ],
      c.PM_TRIAGE_RELEVANT_LABELS,
      "2026-08-01T01:00:00Z",
    );
    const diff = c.diffPmTriageRecord(prediction, truth);
    expect(diff.status).toBe("mismatch");
    expect(diff.correction).toBe(true);
  });

  it("scores a confirmed prediction as a match", () => {
    const prediction = c.extractPmTriagePrediction({
      awInfo: makeAwInfo(),
      safeOutputs: [{ type: "add-labels", item_number: 7, labels: ["ready-for-planning"] }],
      appliedItems: [{ type: "add-labels", applied_at: "2026-08-01T01:00:00Z" }],
      instructionHash: "IH",
    })!;
    // A human re-adds (touches) the same label the run predicted: a confirmation.
    const truth = c.deriveLabelTruth(
      [
        { label: "ready-for-planning", action: "labeled", actorType: "User", permission: "write", createdAt: "2026-08-02T00:00:00Z" },
      ],
      c.PM_TRIAGE_RELEVANT_LABELS,
      "2026-08-01T01:00:00Z",
    );
    const diff = c.diffPmTriageRecord(prediction, truth);
    expect(diff.status).toBe("match");
    expect(diff.correction).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semantic-vs-immutable routing conflict
// ---------------------------------------------------------------------------

describe("corrections — semantic vs immutable routing", () => {
  function routingPrediction() {
    return c.extractSpecialistRoutingPrediction({
      awInfo: makeAwInfo({ workflow_name: "code-review", run_id: 55 }),
      safeOutputs: [{ type: "add-labels", item_number: 42, labels: ["trading-safety"] }],
      appliedItems: [{ type: "add-labels", applied_at: "2026-08-01T01:00:00Z" }],
      instructionHash: "IH",
      changedFiles: ["src/trading/exec.ts"],
    })!;
  }

  it("surfaces a human removal of an immutable-required route as a safety conflict, never weakening it", () => {
    const prediction = routingPrediction();
    expect(prediction.immutableRoutes).toEqual(["trading-safety"]);
    const truth = c.deriveLabelTruth(
      [
        { label: "trading-safety", action: "unlabeled", actorType: "User", permission: "admin", createdAt: "2026-08-02T00:00:00Z" },
      ],
      c.ROUTE_LABELS,
      "2026-08-01T01:00:00Z",
    );
    const diff = c.diffRoutingRecord(prediction, truth);
    expect(diff.status).toBe("mismatch");
    expect(diff.immutableRouteConflicts).toEqual([
      expect.objectContaining({ route: "trading-safety" }),
    ]);
    // The immutable route is preserved on the record regardless of the removal.
    expect(diff.immutableRoutes).toEqual(["trading-safety"]);
  });

  it("does not raise a conflict when the removed route is not immutable-required", () => {
    const prediction = c.extractSpecialistRoutingPrediction({
      awInfo: makeAwInfo({ workflow_name: "code-review", run_id: 56 }),
      safeOutputs: [{ type: "add-labels", item_number: 43, labels: ["security-review"] }],
      appliedItems: [{ type: "add-labels", applied_at: "2026-08-01T01:00:00Z" }],
      instructionHash: "IH",
      changedFiles: ["docs/readme.md"],
    })!;
    expect(prediction.immutableRoutes).toEqual([]);
    const truth = c.deriveLabelTruth(
      [
        { label: "security-review", action: "unlabeled", actorType: "User", permission: "admin", createdAt: "2026-08-02T00:00:00Z" },
      ],
      c.ROUTE_LABELS,
      "2026-08-01T01:00:00Z",
    );
    const diff = c.diffRoutingRecord(prediction, truth);
    expect(diff.status).toBe("mismatch");
    expect(diff.immutableRouteConflicts).toEqual([]);
  });

  it("surfaces an immutable route omitted by semantic routing without waiting for human action", () => {
    const prediction = c.extractSpecialistRoutingPrediction({
      awInfo: makeAwInfo({ workflow_name: "Code Review", run_id: 57 }),
      safeOutputs: [{ type: "create-check-run", item_number: 44 }],
      itemNumber: 44,
      appliedItems: [],
      instructionHash: "IH",
      changedFiles: ["src/trading/policy.ts"],
    })!;
    const diff = c.diffRoutingRecord(prediction, {
      acted: new Set(),
      present: new Set(),
    });
    expect(diff.status).toBe("pending");
    expect(diff.immutableRouteConflicts).toEqual([
      expect.objectContaining({ route: "trading-safety" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Deterministic diff / material hash + sample/correction rate null
// ---------------------------------------------------------------------------

describe("corrections — deterministic report + rates", () => {
  const prediction = {
    id: "w:1:1",
    kind: "pm-triage",
    workflow: "pm-triage",
    itemNumber: 1,
    instructionHash: "IH",
    model: "m",
    createdAt: "2026-08-01T00:00:00Z",
    predictedLabels: ["ready-for-planning"],
  };
  const diff = c.diffPmTriageRecord(prediction, {
    acted: new Set(["ready-for-planning"]),
    present: new Set([]),
  });

  it("computes a material hash independent of generatedAt/commit", () => {
    const a = c.buildReport({ predictions: [prediction], diffs: [diff], window: { days: 7 }, generatedAt: "2026-08-03T00:00:00Z", commit: "x" });
    const b = c.buildReport({ predictions: [prediction], diffs: [diff], window: { days: 7 }, generatedAt: "2030-01-01T00:00:00Z", commit: "y" });
    expect(a.materialHash).toBe(b.materialHash);
  });

  it("returns correctionRate null when the sample size is zero", () => {
    const report = c.buildReport({ predictions: [], diffs: [], window: { days: 7 } });
    expect(report.sampleSize).toBe(0);
    expect(report.correctionRate).toBeNull();
  });

  it("computes correctionRate as mismatch / (match + mismatch)", () => {
    const rate = c.computeCorrectionRate([
      { status: "match" },
      { status: "mismatch" },
      { status: "mismatch" },
      { status: "pending" },
    ]);
    expect(rate.sampleSize).toBe(3);
    expect(rate.correctionRate).toBeCloseTo(2 / 3, 10);
  });

  it("emits no raw content or secrets in the report", () => {
    const report = c.buildReport({ predictions: [prediction], diffs: [diff], window: { days: 7 }, generatedAt: "2026-08-03T00:00:00Z" });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/body|token|secret|prompt/i);
  });
});

// ---------------------------------------------------------------------------
// Cache eviction / rebaseline + state-marker precedence
// ---------------------------------------------------------------------------

describe("corrections — cache and published-hash precedence", () => {
  it("re-baselines on a cache miss without fabricating a correction or suppressing a report", () => {
    const decision = c.decideChange({
      currentHash: "abc",
      publishedHash: null,
      cachedReport: null,
      currentReport: { diffs: [] },
    });
    expect(decision.changed).toBe(true);
    expect(decision.cacheHit).toBe(false);
  });

  it("suppresses a report when the published hash matches (noop)", () => {
    const decision = c.decideChange({
      currentHash: "abc",
      publishedHash: "abc",
      cachedReport: { materialHash: "abc", diffs: [] },
      currentReport: { diffs: [] },
    });
    expect(decision.changed).toBe(false);
  });

  it("treats the published issue hash as authoritative over a stale cache", () => {
    const published = c.readPublishedHash([
      { body: "text\n<!-- correction-state-hash: " + "a".repeat(64) + " -->" },
    ]);
    expect(published).toBe("a".repeat(64));
    // Even with a cache that matches the CURRENT hash, a differing published
    // hash forces a report (changed = true).
    const decision = c.decideChange({
      currentHash: "b".repeat(64),
      publishedHash: published,
      cachedReport: { materialHash: "b".repeat(64), diffs: [] },
      currentReport: { diffs: [] },
    });
    expect(decision.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deterministic fixtures contract (byte-stable)
// ---------------------------------------------------------------------------

describe("corrections — deterministic contract", () => {
  it("matches the committed expected-report.json byte-for-byte", () => {
    const { drift, expectedExists } = c.runFixtureContract(
      path.join(FIXTURES, "contract"),
    );
    expect(expectedExists).toBe(true);
    expect(drift).toBeNull();
  });

  it("contract report carries the immutable-route conflict and a scored sample", () => {
    const { report } = c.runFixtureContract(path.join(FIXTURES, "contract"));
    expect(report.sampleSize as number).toBeGreaterThan(0);
    expect((report.immutableRouteConflicts as unknown[]).length).toBe(1);
    expect(report.pendingCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Path safety + command failure + CLI (injected runner, no GitHub)
// ---------------------------------------------------------------------------

describe("corrections — CLI, path safety, and command failure", () => {
  it("refuses to write outside /tmp/gh-aw in workflow mode", () => {
    const code = c.main(["--out", "/etc/evil.json", "--workflow-mode"], {
      predictions: [],
      truthByItem: {},
    });
    expect(code).toBe(2);
  });

  it("fails loud (non-zero) when the injected runner reports a command failure", () => {
    const failingRunner: Runner = () => ({ status: 1, stdout: "", stderr: "boom" });
    const code = c.main(["--report-prefix", "[factory-corrections] "], {
      // No predictions supplied → live path → resolveRepository → runner fails.
      runner: failingRunner,
      repository: undefined,
    });
    expect(code).toBe(1);
  });

  it("writes a report + cache with an injected prediction set and no GitHub", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corr-cli-"));
    const outPath = path.join(dir, "report.json");
    const cachePath = path.join(dir, "cache.json");
    const code = c.main(["--out", outPath, "--cache", cachePath], {
      predictions: [
        {
          id: "pm-triage:1:1",
          kind: "pm-triage",
          workflow: "pm-triage",
          itemNumber: 1,
          instructionHash: "IH",
          model: "m",
          createdAt: "2026-08-01T00:00:00Z",
          predictedLabels: ["ready-for-planning"],
        },
      ],
      truthByItem: {
        "pm-triage:1:1": { acted: ["ready-for-planning"], present: [] },
      },
    });
    expect(code).toBe(0);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(report.schemaVersion).toBe(c.REPORT_SCHEMA_VERSION);
    expect(report.mode).toBe("staged");
    expect(report.correctionRate).toBe(1);
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(cache.materialHash).toBe(report.materialHash);
    expect(cache.predictions).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--check contract mode exits 0 and contacts no GitHub", () => {
    const code = c.main([
      "--check",
      "--fixtures",
      path.join(FIXTURES, "contract"),
    ]);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Report-only workflow contract
// ---------------------------------------------------------------------------

describe("corrections — agentic-corrections workflow contract", () => {
  const source = fs.readFileSync(
    path.join(root, ".github/workflows/agentic-corrections.md"),
    "utf8",
  );
  const lock = fs.readFileSync(
    path.join(root, ".github/workflows/agentic-corrections.lock.yml"),
    "utf8",
  );

  it("keeps summaries manual while the native watchdog owns weekly collection", () => {
    expect(source).toContain("workflow_dispatch:");
    expect(source).not.toContain("schedule:");
    expect(source).toContain("factory-watchdog.yml");
  });

  it("persists deterministic receipts before model execution", () => {
    expect(source).toContain("pre-agent-steps:");
    expect(source).toContain('mode: "governance"');
    expect(source).toContain("runCollectionStep({ github, context, core,");
    expect(source).toContain("if: always()");
    expect(source).toContain("actions/upload-artifact@v4");
  });

  it("exposes only the trusted collector and cat on the bash allowlist", () => {
    expect(source).not.toContain('"node scripts/agentic/');
    expect(source).toContain('"cat /tmp/gh-aw/watchdog/correction-report.json"');
    expect(source).toContain('"cat /tmp/gh-aw/watchdog/receipts.json"');
    // No add-labels/edit tooling on the allowlist.
    expect(source).not.toContain('"gh ');
  });

  it("keeps read-only permissions", () => {
    const fmEnd = source.indexOf("\n---", 3);
    const frontmatter = source.slice(0, fmEnd);
    expect(frontmatter).toContain("contents: read");
    expect(frontmatter).toContain("issues: read");
    expect(frontmatter).toContain("pull-requests: read");
    expect(frontmatter).not.toMatch(/contents:\s*write/);
    expect(frontmatter).not.toMatch(/issues:\s*write/);
  });

  it("does not let optional model summaries mutate canonical reports", () => {
    expect(source).not.toContain("create-issue:");
    expect(source).not.toContain("close-older-issues:");
    expect(source).not.toContain("update-issue:");
    expect(source).toContain("canonicalReport");
    expect(source).toContain("noop:");
  });

  it("embeds the correction-state-hash marker instruction", () => {
    expect(source).toContain(
      "<!-- correction-state-hash: MATERIAL_STATE_HASH -->",
    );
  });

  it("uses h3/h4 headings and alerts and no emoji", () => {
    expect(source).toContain("### ");
    expect(source).toContain("#### ");
    expect(source).toContain("> [!WARNING]");
    // Crude emoji guard: no characters outside the BMP typical text range.
    expect(source).not.toMatch(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/u);
  });

  it("is report-only: no create-pull-request, push, edit, label, or deletion output", () => {
    const fmEnd = source.indexOf("\n---", 3);
    const frontmatter = source.slice(0, fmEnd);
    for (const forbidden of [
      "create-pull-request",
      "push-to-pull-request-branch",
      "push-to-branch",
      "update-issue",
      "add-labels",
    ]) {
      expect(frontmatter).not.toContain(forbidden);
    }
    expect(lock).not.toContain('"create_issue":');
    expect(lock).toContain('"noop":');
    expect(lock).not.toContain('"create_pull_request":');
    expect(lock).not.toContain('"push_to_pull_request_branch":');
    expect(lock).not.toContain('"add_labels":');
    expect(lock).not.toContain('"update_issue":');
  });

  it("compiles bounded summary-only output and explicit failure handling", () => {
    expect(lock).toContain('"max":1');
    expect(lock).not.toContain('"title_prefix":"[factory-corrections] "');
    expect(source).toContain("report_incomplete");
  });
});
