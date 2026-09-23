/**
 * MonitorOps collector contract tests.
 *
 * These tests exercise the deterministic factory-health collector
 * (`scripts/agentic/collect-factory-health.cjs`) entirely against synthetic
 * fixtures and an injected command runner. No test contacts GitHub — the CLI
 * path is driven through the same injected-runner seam so "CLI tests must not
 * call GitHub" holds by construction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

const root = path.resolve(__dirname, "../..");
const collectorPath = path.join(
  root,
  ".github",
  "..",
  "scripts",
  "agentic",
  "collect-factory-health.cjs",
);

type Runner = (command: string, args: string[]) => {
  status: number;
  stdout: string;
  stderr: string;
};

interface Collector {
  SNAPSHOT_SCHEMA_VERSION: number;
  computeWindow(mode: string, now: Date | string): {
    mode: string;
    days: number;
    start: string;
    end: string;
  };
  listWorkflowSources(dir: string): string[];
  parseWorkflowSource(id: string, text: string): {
    id: string;
    active: boolean;
    perRunCreditCap: number | null;
    perDayCreditCap: number | null;
    safeOutputs: string[];
  };
  buildWorkflowInventory(dir: string): Array<Record<string, unknown>>;
  normalizeUsage(
    logsJson: unknown,
    knownIds: string[],
    window: unknown,
    options?: unknown,
  ): Record<string, Record<string, unknown>>;
  normalizeIssues(
    issues: unknown,
    window: unknown,
    policy: unknown,
    now: Date | string,
  ): Record<string, unknown>;
  normalizePullRequests(prs: unknown): Record<string, unknown>;
  computeTelemetryCoverage(
    workflows: unknown[],
  ): Record<string, number | null>;
  normalizeStatus(status: unknown): Record<string, Record<string, unknown>>;
  deriveWorkflowId(row: Record<string, unknown>): string | null;
  parseDurationSeconds(value: unknown): number | null;
  computeMaterialHash(snapshot: unknown): string;
  readPublishedHash(issues: unknown): string | null;
  decideChange(input: Record<string, unknown>): {
    changed: boolean;
    currentHash: string;
    publishedHash: string | null;
    cacheHit: boolean;
    delta: unknown;
  };
  evaluateThresholds(
    snapshot: unknown,
    policy: unknown,
    watermarks: unknown,
    config?: unknown,
  ): { evaluated: string[]; breaches: Array<{ id: string }>; watermarks: Record<string, number> };
  buildSnapshot(inputs: Record<string, unknown>): Record<string, unknown>;
  validateOutputPath(target: string, options?: unknown): string;
  collect(options: Record<string, unknown>): {
    snapshot: Record<string, unknown>;
    decision: Record<string, unknown>;
    cacheRecord: Record<string, unknown>;
  };
  main(argv: string[], deps?: Record<string, unknown>): number;
}

const collector = jest.requireActual<Collector>(collectorPath);

function parseUniqueJson<T>(filePath: string): T {
  const document = parseDocument(fs.readFileSync(filePath, "utf8"), {
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${filePath}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document.toJS() as T;
}

const fixtures = parseUniqueJson<{
  now: string;
  status: unknown[];
  logsGovernance: unknown;
  auxRuns: Record<string, unknown[]>;
  issues: unknown[];
  pullRequests: unknown[];
  reportIssuesNone: unknown[];
  reportIssuesWithHash: unknown[];
}>(
  path.join(__dirname, "fixtures/monitor-ops/gh-outputs.json"),
);

const policy = JSON.parse(
  fs.readFileSync(path.join(root, ".github/agentic-policy.json"), "utf8"),
);

const workflowsDir = path.join(root, ".github", "workflows");

/**
 * Build a fake runner that answers gh commands from fixture data. Any command
 * this collector might issue is mapped to a fixture; nothing reaches the
 * network. `reportIssues` selects which report-history fixture the published
 * hash is read from.
 */
function fakeRunner(overrides: {
  defaultBranch?: string;
  status?: unknown;
  logs?: unknown;
  auxRuns?: Record<string, unknown[]>;
  issues?: unknown;
  prs?: unknown;
  reportIssues?: unknown;
} = {}): Runner {
  const defaultBranch = overrides.defaultBranch || "main";
  const branchRows = (rows: unknown[]) => rows.map((row) => ({ head_branch: defaultBranch, ...row as object }));
  const json = (value: unknown) => ({
    status: 0,
    stdout: JSON.stringify(value ?? []),
    stderr: "",
  });
  return (command, args) => {
    expect(command).toBe("gh");
    const joined = args.join(" ");
    if (joined.includes("repo view")) return json({ nameWithOwner: "example/repo" });
    if (args[0] === "api" && args.some((arg) => /^repos\/[^/]+\/[^/?]+$/.test(arg))) {
      return json({ default_branch: defaultBranch });
    }
    if (joined.includes("/actions/workflows")) return json({ workflows: [
      ...(overrides.status ?? fixtures.status) as unknown[],
      { id: "agentic-evals", enabled: true }, { id: "ci", enabled: true },
    ] });
    if (joined.includes("/actions/runs?")) {
      const logs = (overrides.logs ?? fixtures.logsGovernance) as { runs: unknown[] };
      const auxiliary = Object.entries(overrides.auxRuns ?? fixtures.auxRuns)
        .flatMap(([workflow, rows]) => rows.map((row) => ({ ...row as object, workflow })));
      return json({ workflow_runs: branchRows([...logs.runs, ...auxiliary]) });
    }
    if (joined.includes("/issues?")) {
      const reportIssues = (overrides.reportIssues ?? fixtures.reportIssuesNone) as Array<Record<string, unknown>>;
      return json([
        ...((overrides.issues ?? fixtures.issues) as unknown[]),
        ...reportIssues.map((issue) => ({
          ...issue, state: "open", labels: ["agentic-factory", "report"],
          user: { login: "github-actions[bot]" },
          body: `${issue.body}\n<!-- factory-report:v1 governance -->`,
        })),
      ]);
    }
    if (joined.includes("aw status")) return json(overrides.status ?? fixtures.status);
    if (joined.includes("aw logs")) {
      const logs = (overrides.logs ?? fixtures.logsGovernance) as { runs: unknown[] };
      return json({ ...logs, runs: branchRows(logs.runs) });
    }
    if (joined.includes("run list")) {
      const wfIndex = args.indexOf("--workflow");
      const file = wfIndex >= 0 ? args[wfIndex + 1] : "";
      const id = file.replace(/\.(ya?ml)$/, "");
      const table = overrides.auxRuns ?? fixtures.auxRuns;
      return json(table[id] ?? []);
    }
    if (joined.includes("issue list") && joined.includes("in:title")) {
      return json(overrides.reportIssues ?? fixtures.reportIssuesNone);
    }
    if (joined.includes("issue list")) return json(overrides.issues ?? fixtures.issues);
    if (joined.includes("pr list")) return json(overrides.prs ?? fixtures.pullRequests);
    throw new Error(`unexpected gh command in test: ${joined}`);
  };
}

describe("MonitorOps collector — explicit UTC windows", () => {
  it("daily window is the last 24 full hours ending at the run start", () => {
    const w = collector.computeWindow("daily", new Date("2026-08-10T00:15:37Z"));
    expect(w.start).toBe("2026-08-09T00:00:00.000Z");
    expect(w.end).toBe("2026-08-10T00:00:00.000Z");
    expect(w.days).toBe(1);
  });

  it("governance window is the last 7 full days ending at the run start", () => {
    const w = collector.computeWindow("governance", new Date("2026-08-10T00:15:37Z"));
    expect(w.start).toBe("2026-08-03T00:00:00.000Z");
    expect(w.end).toBe("2026-08-10T00:00:00.000Z");
    expect(w.days).toBe(7);
  });

  it("rejects an unknown mode", () => {
    expect(() => collector.computeWindow("hourly", new Date())).toThrow(/unknown mode/);
  });
});

describe("MonitorOps collector — workflow coverage", () => {
  it("inventories every workflow source and excludes AGENTS.md", () => {
    const ids = collector.listWorkflowSources(workflowsDir);
    expect(ids).not.toContain("AGENTS");
    expect(ids).toContain("agentic-governance");
    expect(ids).toContain("daily-repo-status");
  });

  it("normalizes the live gh-aw status shape", () => {
    const status = collector.normalizeStatus([
      {
        workflow: "pm-triage",
        compiled: "Yes",
        status: "active",
      },
    ]);
    expect(status["pm-triage"]).toEqual({
      compiled: true,
      enabled: true,
    });
  });

  it.each([
    [".github/workflows/ci.yml", "ci"],
    [".github/workflows/ci.yml@refs/heads/main", "ci"],
    [".github/workflows/ci.yml@refs/tags/v2.1.0", "ci"],
    [".github/workflows/ci.yml@refs/pull/600/merge", "ci"],
    [".github/workflows/pm-triage.lock.yml@refs/heads/feature/safety", "pm-triage"],
    [".github/workflows/ci.yaml@refs/tags/v2.1.0", "ci"],
  ])("attributes workflow %s before deriving its basename", (workflowPath, id) => {
    expect(collector.deriveWorkflowId({ path: workflowPath })).toBe(id);
    expect(collector.normalizeStatus([{ path: workflowPath, state: "active" }])[id]).toMatchObject({ enabled: true });
    const window = collector.computeWindow("governance", fixtures.now);
    expect(collector.normalizeUsage({ runs: [{
      workflow_path: workflowPath, created_at: "2026-08-05T10:00:00Z", conclusion: "failure",
    }] }, [id], window)[id]).toMatchObject({ runs: 1, conclusions: { failure: 1 } });
  });

  it.each([
    ".github/workflows/ci.yml@notes",
    ".github/workflows/ci@nightly.yml",
    ".github/workflows/ci.yml@refs/",
    ".github/workflows/ci.yml@refs/heads/",
  ])("does not attribute unrelated or incomplete suffix text %s to ci", (workflowPath) => {
    expect(collector.deriveWorkflowId({ path: workflowPath })).not.toBe("ci");
  });

  it("represents every active workflow, including zero-run workflows", () => {
    const { snapshot } = collector.collect({
      mode: "governance",
      now: new Date(fixtures.now),
      repoRoot: root,
      runner: fakeRunner(),
      policy,
    });

    const inventoryIds = collector.listWorkflowSources(workflowsDir);
    const workflows = snapshot.workflows as Array<Record<string, unknown>>;
    const ids = workflows.map((w) => w.id as string);
    // Every GH-AW source is covered...
    for (const id of inventoryIds) expect(ids).toContain(id);
    // ...plus the auxiliary eval/harness Actions workflows.
    expect(ids).toContain("agentic-evals");
    expect(ids).toContain("ci");

    // A workflow with no runs in the window is present with runs: 0, not omitted.
    const daily = workflows.find((w) => w.id === "daily-repo-status")!;
    const dailyUsage = daily.usage as Record<string, unknown>;
    expect(dailyUsage.runs).toBe(0);
    expect(dailyUsage.aiCredits).toBeNull();
  });

  it("represents a new auxiliary workflow as unavailable before it reaches the default branch", () => {
    const runner = fakeRunner();
    const missingRunner: Runner = (command, args) => {
      if (
        command === "gh" &&
        args.some((arg) => arg.includes("/actions/workflows"))
      ) {
        return {
          status: 0,
          stdout: JSON.stringify({ workflows: fixtures.status }),
          stderr: "",
        };
      }
      return runner(command, args);
    };
    const { snapshot } = collector.collect({
      mode: "governance",
      now: new Date(fixtures.now),
      repoRoot: root,
      runner: missingRunner,
      policy,
    });
    const workflow = (
      snapshot.workflows as Array<Record<string, unknown>>
    ).find((entry) => entry.id === "agentic-evals");
    expect(workflow).toMatchObject({
      usage: null,
      telemetryError: "workflow-not-found-on-default-branch",
    });
  });
});

describe("MonitorOps collector — null-not-zero telemetry", () => {
  const window = collector.computeWindow("governance", new Date(fixtures.now));
  const knownIds = ["pm-triage", "code-review", "daily-repo-status"];
  const usage = collector.normalizeUsage(
    fixtures.logsGovernance,
    knownIds,
    window,
  );

  it("aggregates only in-window runs and reports numeric credits when available", () => {
    const pm = usage["pm-triage"] as Record<string, unknown>;
    expect(pm.runs).toBe(3); // the 2026-07-01 run is outside the 7-day window
    expect(pm.aiCredits).toBe(120 + 3000 + 140);
    expect(pm.maxRunAiCredits).toBe(3000);
  });

  describe("MonitorOps collector — telemetry coverage", () => {
    it("does not count zero-run workflows as missing cost telemetry", () => {
      const coverage = collector.computeTelemetryCoverage([
        {
          active: true,
          usage: { runs: 0, aiCredits: null },
        },
        {
          active: true,
          usage: { runs: 2, aiCredits: 15 },
        },
      ]);
      expect(coverage).toEqual({
        activeWorkflows: 2,
        workflowsWithRunData: 1,
        workflowsWithCostData: 1,
        costCoverage: 1,
      });
    });
  });

  it("reports tokens as null when only an unavailable zero is present", () => {
    const pm = usage["pm-triage"] as Record<string, unknown>;
    expect(pm.tokens).toBeNull();
  });

  it("reports cost/token as null when no signal exists", () => {
    const cr = usage["code-review"] as Record<string, unknown>;
    expect(cr.aiCredits).toBeNull();
    expect(cr.tokens).toBeNull();
  });

  it("keeps safe-output/correction/self-heal metrics null until authoritative", () => {
    const pm = usage["pm-triage"] as Record<string, unknown>;
    expect(pm.safeOutputOutcomes).toBeNull();
    expect(pm.corrections).toBeNull();
    expect(pm.selfHeal).toBeNull();
  });

  it("never invents zero for a zero-run workflow's cost fields", () => {
    const zero = usage["daily-repo-status"] as Record<string, unknown>;
    expect(zero.runs).toBe(0);
    expect(zero.aiCredits).toBeNull();
    expect(zero.tokens).toBeNull();
  });

  it("normalizes live gh-aw workflow_path, aic, and duration fields", () => {
    const liveShape = collector.normalizeUsage(
      {
        runs: [
          {
            workflow_path: ".github/workflows/pm-triage.lock.yml",
            created_at: "2026-08-05T10:00:00Z",
            conclusion: "success",
            duration: "5.3m",
            aic: 12.5,
            total_tokens: 0,
          },
        ],
      },
      ["pm-triage"],
      window,
    )["pm-triage"] as Record<string, unknown>;
    expect(liveShape.runs).toBe(1);
    expect(liveShape.aiCredits).toBe(12.5);
    expect(liveShape.durationSecondsTotal).toBe(318);
    expect(liveShape.tokens).toBeNull();
  });

  it("parses compact duration values", () => {
    expect(collector.parseDurationSeconds("1h2m3s")).toBe(3723);
    expect(collector.parseDurationSeconds("5.3m")).toBe(318);
    expect(collector.parseDurationSeconds("not-a-duration")).toBeNull();
  });
});

describe("MonitorOps collector — exact default-branch scope", () => {
  it("queries the discovered default branch and excludes same-SHA release runs before costs or failure thresholds", () => {
    const defaultBranch = "release-default/stable";
    const run = {
      workflow: "pm-triage", createdAt: "2026-08-05T10:00:00Z", head_sha: "a".repeat(40),
      head_branch: defaultBranch, conclusion: "success", aiCredits: 7,
    };
    const runner = jest.fn(fakeRunner({
      defaultBranch,
      logs: { runs: [
        { ...run, id: 1 },
        { ...run, id: 2, head_branch: "release/v2.1", conclusion: "failure", aiCredits: 9000 },
        { ...run, id: 3, head_branch: "release/v2.1", conclusion: "failure", aiCredits: 9000 },
      ] },
      auxRuns: {},
    }));
    const { snapshot } = collector.collect({ repoRoot: root, repository: "example/repo", now: fixtures.now, runner, policy });
    expect(snapshot.defaultBranch).toBe(defaultBranch);
    expect(runner).toHaveBeenCalledWith("gh", expect.arrayContaining([
      expect.stringContaining("actions/runs?branch=release-default%2Fstable&created="),
    ]));
    expect(runner).toHaveBeenCalledWith("gh", expect.arrayContaining(["--repo", "example/repo", "--ref", defaultBranch]));
    const workflow = (snapshot.workflows as Array<Record<string, unknown>>).find((item) => item.id === "pm-triage");
    expect(workflow).toMatchObject({ usage: { runs: 1, conclusions: { success: 1 }, aiCredits: 7, repeatedFailures: 0 } });
    expect((snapshot.thresholds as { breaches: unknown[] }).breaches).toEqual([]);
    expect(snapshot.sources).toMatchObject({
      runs: { branch: defaultBranch, excludedBranchRecords: 2, includedRecords: 1 },
      usage: { branch: defaultBranch, excludedBranchRecords: 2, includedRecords: 1 },
    });
  });

  it("keeps absent run-branch data incomplete rather than treating it as zero/pass", () => {
    const { snapshot } = collector.collect({
      repoRoot: root, now: fixtures.now, policy,
      runner: fakeRunner({ logs: { runs: [
        { workflow: "pm-triage", head_branch: null, createdAt: "2026-08-05T10:00:00Z", conclusion: "failure" },
      ] } }),
    });
    expect(snapshot).toMatchObject({
      collection: { completeness: "partial" },
      sources: { runs: { completeness: "partial", reason: "run-branch-unavailable", missingBranchRecords: 1 } },
    });
    expect((snapshot.workflows as Array<Record<string, unknown>>).find((item) => item.id === "pm-triage"))
      .toMatchObject({ usage: { runs: null, aiCredits: null } });
  });

  it("does not fall back to repository-wide runs when the default branch is unavailable", () => {
    const normal = fakeRunner();
    const runner = jest.fn((command: string, args: string[]) => {
      if (args[0] === "api" && args.some((arg) => /^repos\/[^/]+\/[^/?]+$/.test(arg))) {
        return { status: 1, stdout: "", stderr: "HTTP 503" };
      }
      return normal(command, args);
    });
    const { snapshot } = collector.collect({ repoRoot: root, repository: "example/repo", now: fixtures.now, policy, runner });
    expect(snapshot).toMatchObject({
      defaultBranch: null, collection: { completeness: "partial" },
      sources: { runs: { completeness: "unavailable", reason: "default-branch-unavailable" } },
    });
    expect(runner.mock.calls.some(([, args]) => args.some((arg) => arg.includes("/actions/runs?")))).toBe(false);
    expect(runner.mock.calls.some(([, args]) => args[0] === "aw" && args[1] === "logs")).toBe(false);
  });
});

describe("MonitorOps collector — material hash determinism", () => {
  function snapshotAt(nowIso: string): Record<string, unknown> {
    const { snapshot } = collector.collect({
      mode: "governance",
      now: new Date(nowIso),
      repoRoot: root,
      runner: fakeRunner(),
      policy,
    });
    return snapshot;
  }

  it("is stable across runs that share the same closed window", () => {
    const a = snapshotAt("2026-08-10T00:15:37Z");
    const b = snapshotAt("2026-08-10T09:59:59Z");
    const stateA = a.materialState as Record<string, unknown>;
    const stateB = b.materialState as Record<string, unknown>;
    // Different generatedAt, identical material state → identical hash.
    expect(a.generatedAt).not.toBe(b.generatedAt);
    expect(stateA.hash).toBe(stateB.hash);
    expect(collector.computeMaterialHash(a)).toBe(collector.computeMaterialHash(b));
  });

  it("changes when workflow conclusions change", () => {
    const base = snapshotAt("2026-08-10T00:15:37Z");
    const { snapshot: mutated } = collector.collect({
      mode: "governance",
      now: new Date("2026-08-10T00:15:37Z"),
      repoRoot: root,
      runner: fakeRunner({
        logs: { runs: [{ workflow: "pm-triage", createdAt: "2026-08-05T10:00:00Z", conclusion: "success" }] },
      }),
      policy,
    });
    const baseState = base.materialState as Record<string, unknown>;
    const mutatedState = mutated.materialState as Record<string, unknown>;
    expect(mutatedState.hash).not.toBe(baseState.hash);
  });
});

describe("MonitorOps collector — issue-marker precedence and cache", () => {
  it("reads the published hash from the newest report issue marker", () => {
    expect(collector.readPublishedHash(fixtures.reportIssuesWithHash)).toBe(
      "2".repeat(64),
    );
    expect(collector.readPublishedHash(fixtures.reportIssuesNone)).toBeNull();
  });

  it("treats the issue marker as authoritative over any cached hash", () => {
    const cached = { materialState: { hash: "deadbeef" }, workflows: [] };
    const decision = collector.decideChange({
      currentHash: "2".repeat(64),
      publishedHash: "2".repeat(64),
      cachedSnapshot: cached,
      currentSnapshot: { workflows: [] },
    });
    // Published equals current → noop, even though the cache hash differs.
    expect(decision.changed).toBe(false);
  });

  it("does not suppress a report on a cache miss", () => {
    const decision = collector.decideChange({
      currentHash: "abc",
      publishedHash: null,
      cachedSnapshot: null,
      currentSnapshot: { workflows: [] },
    });
    expect(decision.changed).toBe(true);
    expect(decision.cacheHit).toBe(false);
  });

  it("produces a noop when material state matches the published hash", () => {
    const priorReport = {
      number: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
      body: "Existing canonical report awaiting its first material hash",
    };
    const { snapshot } = collector.collect({
      mode: "governance",
      now: new Date(fixtures.now),
      repoRoot: root,
      runner: fakeRunner({ reportIssues: [priorReport] }),
      policy,
    });
    const currentHash = (snapshot.materialState as Record<string, string>).hash;
    // Feed the just-computed hash back as the published hash → unchanged.
    const { snapshot: second } = collector.collect({
      mode: "governance",
      now: new Date(fixtures.now),
      repoRoot: root,
      runner: fakeRunner({
        reportIssues: [
          {
            ...priorReport,
            body: `report\n<!-- factory-state-hash: ${currentHash} -->`,
          },
        ],
      }),
      policy,
    });
    expect((second.materialState as Record<string, unknown>).changed).toBe(false);
  });
});

describe("MonitorOps collector — threshold evaluation", () => {
  const { snapshot } = (() => {
    return collector.collect({
      mode: "governance",
      now: new Date(fixtures.now),
      repoRoot: root,
      runner: fakeRunner(),
      policy,
    });
  })();
  const breachIds = () =>
    ((snapshot.thresholds as Record<string, Array<{ id: string }>>).breaches || []).map(
      (b) => b.id,
    );

  it("flags eval/harness failure from an eval workflow run", () => {
    expect(breachIds()).toContain("eval_or_harness_failure");
  });

  it("flags repeated workflow failure (>= 2 consecutive)", () => {
    expect(breachIds()).toContain("repeated_workflow_failure");
  });

  it("flags AI credits over a workflow's configured per-run cap", () => {
    expect(breachIds()).toContain("ai_credits_over_run_cap");
  });

  it("flags WIP at or above the configured cap", () => {
    const inv = [
      {
        id: "pm-triage",
        sourcePath: "x",
        lockPath: "y",
        compiled: true,
        active: true,
        perRunCreditCap: 1000,
        perDayCreditCap: 2500,
        safeOutputs: [],
        sourceHash: "h",
        lockHash: "l",
      },
    ];
    const built = collector.buildSnapshot({
      mode: "governance",
      now: new Date(fixtures.now),
      inventory: inv,
      status: {},
      usage: { "pm-triage": null },
      issues: {
        wipCap: 20,
        openActionableOpportunities: 20,
        netOpened: 0,
        staleWip: [],
        blocked: [],
      },
      pullRequests: null,
      hashes: { sourceLockDrift: [] },
      watermarks: {},
      policy,
    });
    const ids = (
      (built.thresholds as Record<string, Array<{ id: string }>>).breaches || []
    ).map((b) => b.id);
    expect(ids).toContain("wip_over_cap");
  });

  it("cannot breach on unknown (null) correction/safe-output metrics", () => {
    const inv = [
      {
        id: "pm-triage",
        sourcePath: "x",
        lockPath: "y",
        compiled: true,
        active: true,
        perRunCreditCap: 1000,
        perDayCreditCap: 2500,
        safeOutputs: [],
        sourceHash: "h",
        lockHash: "l",
      },
    ];
    const built = collector.buildSnapshot({
      mode: "governance",
      now: new Date(fixtures.now),
      inventory: inv,
      status: {},
      usage: {
        "pm-triage": {
          runs: 1,
          conclusions: { success: 1 },
          repeatedFailures: 0,
          durationSecondsTotal: 5,
          aiCredits: 10,
          maxRunAiCredits: 10,
          tokens: null,
          safeOutputOutcomes: null,
          corrections: null,
          selfHeal: null,
        },
      },
      issues: null,
      pullRequests: null,
      hashes: { sourceLockDrift: [] },
      watermarks: {},
      policy,
    });
    const ids = (
      (built.thresholds as Record<string, Array<{ id: string }>>).breaches || []
    ).map((b) => b.id);
    expect(ids).toHaveLength(0);
  });

  it("flags required telemetry missing for two published periods via watermark", () => {
    const inv = [
      {
        id: "pm-triage",
        sourcePath: "x",
        lockPath: "y",
        compiled: true,
        active: true,
        perRunCreditCap: 1000,
        perDayCreditCap: 2500,
        safeOutputs: [],
        sourceHash: "h",
        lockHash: "l",
      },
    ];
    const usage = {
      "pm-triage": {
        runs: 1,
        conclusions: { success: 1 },
        repeatedFailures: 0,
        durationSecondsTotal: 5,
        aiCredits: null,
        maxRunAiCredits: null,
        tokens: null,
        safeOutputOutcomes: null,
        corrections: null,
        selfHeal: null,
      },
    };
    const first = collector.buildSnapshot({
      mode: "governance",
      now: new Date(fixtures.now),
      inventory: inv,
      status: {},
      usage,
      issues: null,
      pullRequests: null,
      hashes: { sourceLockDrift: [] },
      watermarks: { missingTelemetryStreak: 0 },
      policy,
    });
    const firstIds = (
      (first.thresholds as Record<string, Array<{ id: string }>>).breaches || []
    ).map((b) => b.id);
    expect(firstIds).not.toContain("telemetry_missing_two_periods");

    const second = collector.buildSnapshot({
      mode: "governance",
      now: new Date("2026-08-17T00:15:37Z"),
      inventory: inv,
      status: {},
      usage,
      issues: null,
      pullRequests: null,
      hashes: { sourceLockDrift: [] },
      watermarks: {
        missingTelemetryStreak: 1,
        lastTelemetryWindow: "2026-08-03T00:00:00.000Z/2026-08-10T00:00:00.000Z",
      },
      policy,
    });
    const secondIds = (
      (second.thresholds as Record<string, Array<{ id: string }>>).breaches || []
    ).map((b) => b.id);
    expect(secondIds).toContain("telemetry_missing_two_periods");
  });
});

describe("MonitorOps collector — path safety", () => {
  it("rejects an output path outside /tmp/gh-aw in workflow mode", () => {
    expect(() =>
      collector.validateOutputPath("/etc/passwd", { workflowMode: true }),
    ).toThrow(/refusing to write outside/);
  });

  it("allows an output path under /tmp/gh-aw in workflow mode", () => {
    const resolved = collector.validateOutputPath(
      "/tmp/gh-aw/monitor/snapshot.json",
      { workflowMode: true },
    );
    expect(resolved.endsWith("snapshot.json")).toBe(true);
  });
});

describe("MonitorOps collector — CLI (no GitHub access)", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-ops-cli-"));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a versioned snapshot through the injected runner", () => {
    const out = path.join(tmpDir, "snapshot.json");
    const rc = collector.main(
      ["--mode", "daily", "--out", out, "--now", fixtures.now],
      { runner: fakeRunner(), repoRoot: root, policy },
    );
    expect(rc).toBe(0);
    const snap = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(snap.schemaVersion).toBe(collector.SNAPSHOT_SCHEMA_VERSION);
    expect(snap.mode).toBe("daily");
    expect(Array.isArray(snap.workflows)).toBe(true);
    expect(snap.materialState).toHaveProperty("hash");
  });

  it("rejects an invalid --mode without touching GitHub", () => {
    const rc = collector.main(["--mode", "hourly"], {
      runner: () => {
        throw new Error("runner must not be called for invalid mode");
      },
      repoRoot: root,
      policy,
    });
    expect(rc).toBe(2);
  });

  it.each(["", "example/repo"])("fails loud when commands fail with repository resolution %j", (repository) => {
    const rc = collector.main(
      ["--mode", "daily", "--out", path.join(tmpDir, "failed.json")],
      {
        runner: () => ({
          status: 1,
          stdout: "",
          stderr: "simulated API failure",
        }),
        repoRoot: root,
        policy,
        repository,
      },
    );
    expect(rc).toBe(1);
    const failed = JSON.parse(fs.readFileSync(path.join(tmpDir, "failed.json"), "utf8"));
    if (repository) {
      expect(failed).toMatchObject({
        collection: { completeness: "partial" },
        issues: { openedInWindow: null, openActionableOpportunities: null },
        sources: { issues: { completeness: "unavailable" }, runs: { completeness: "unavailable" } },
      });
    } else {
      expect(failed).toMatchObject({ status: "failed", completeness: "unavailable", metrics: null });
    }
  });
});
