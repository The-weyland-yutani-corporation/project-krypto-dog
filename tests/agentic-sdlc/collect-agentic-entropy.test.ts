/**
 * Report-only entropy collector contract tests.
 *
 * These tests exercise the deterministic entropy collector
 * (`scripts/agentic/collect-agentic-entropy.cjs`) entirely against synthetic
 * fixtures, hand-built rule contexts, and an injected `gh` runner. No test
 * contacts GitHub — every path that could read GitHub is driven through the
 * injected-runner seam or omits the report prefix entirely, so "tests must not
 * contact GitHub" holds by construction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const collectorPath = path.join(
  root,
  "scripts",
  "agentic",
  "collect-agentic-entropy.cjs",
);

type RuleResult = {
  check: { ruleId: string; severity: string; status: string; summary: string };
  violations: Array<{
    ruleId: string;
    severity: string;
    path: string;
    evidence: Record<string, unknown>;
    remediation: string;
  }>;
};

interface Entropy {
  MANIFEST_SCHEMA_VERSION: number;
  ZERO_TOLERANCE: string;
  ADVISORY: string;
  PASS: string;
  FAIL: string;
  UNKNOWN: string;
  DIMENSIONS: Array<{ id: string; title: string; ruleIds: string[] }>;
  rulePolicyValid(ctx: Record<string, unknown>): RuleResult;
  ruleWorkflowSourcesCompiled(ctx: Record<string, unknown>): RuleResult;
  ruleDocReferencesResolve(ctx: Record<string, unknown>): RuleResult;
  ruleWorkflowImportsExist(ctx: Record<string, unknown>): RuleResult;
  ruleDuplicatedPolicyLiterals(ctx: Record<string, unknown>): RuleResult;
  ruleOpportunityWipOverCap(ctx: Record<string, unknown>): RuleResult;
  ruleWorkflowTelemetryCoverage(ctx: Record<string, unknown>): RuleResult;
  ruleArchitectureBoundaryHotspots(ctx: Record<string, unknown>): RuleResult;
  ruleSourceFileSizeHotspots(ctx: Record<string, unknown>): RuleResult;
  ruleTodoMarkers(ctx: Record<string, unknown>): RuleResult;
  ruleNoProhibitedLiveExecutor(ctx: Record<string, unknown>): RuleResult;
  ruleGeneratedDocMarkersPresent(ctx: Record<string, unknown>): RuleResult;
  parseImports(text: string): string[];
  collectPolicyLiterals(policy: unknown): string[];
  buildDimensions(
    checks: Array<Record<string, unknown>>,
    violations: Array<Record<string, unknown>>,
  ): Array<{ id: string; status: string; evidence: unknown[] }>;
  computeMaterialHash(manifest: unknown): string;
  readPublishedHash(issues: unknown): string | null;
  decideChange(input: Record<string, unknown>): {
    changed: boolean;
    cacheHit: boolean;
    publishedHash: string | null;
    delta: unknown;
  };
  computeDelta(a: unknown, b: unknown): { added: string[]; removed: string[] };
  buildManifest(ctx: Record<string, unknown>): Record<string, unknown>;
  collect(options: Record<string, unknown>): {
    manifest: Record<string, unknown>;
    decision: Record<string, unknown>;
    cacheRecord: Record<string, unknown>;
  };
  main(argv: string[], deps?: Record<string, unknown>): number;
}

const entropy = jest.requireActual<Entropy>(collectorPath);
const policyLoader = jest.requireActual<{
  loadAgenticPolicy: (p?: string) => unknown;
}>(path.join(root, ".github/scripts/agentic-policy.cjs"));

const snapshotFixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/entropy/monitor-snapshot.json"),
    "utf8",
  ),
);

/** Build a minimal rule context; every field can be overridden per test. */
function baseCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoRoot: root,
    collectedAt: "2026-08-10T00:00:00.000Z",
    commit: null,
    loadAgenticPolicy: policyLoader.loadAgenticPolicy,
    inventory: [],
    requiredSupportFiles: [],
    docSurfaces: [],
    proseSurfaces: [],
    policyLiterals: [],
    snapshot: null,
    tradingSources: [],
    appSources: [],
    allSources: [],
    markerSources: [],
    lineThreshold: 500,
    sourceHashes: null,
    monitorOps: null,
    ...overrides,
  };
}

/** Create a throwaway repo skeleton and return its absolute path. */
function makeTmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "entropy-rule-"));
}

function write(repo: string, rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// Rule: policy_valid
// ---------------------------------------------------------------------------

describe("entropy rule — policy_valid", () => {
  it("passes for the real, valid canonical policy", () => {
    const r = entropy.rulePolicyValid(baseCtx());
    expect(r.check.status).toBe(entropy.PASS);
    expect(r.check.severity).toBe(entropy.ZERO_TOLERANCE);
    expect(r.violations).toHaveLength(0);
  });

  it("fails when the canonical policy is malformed", () => {
    const repo = makeTmpRepo();
    write(repo, ".github/agentic-policy.json", "{ not json");
    write(repo, ".github/scripts/agentic-policy.cjs", "");
    const r = entropy.rulePolicyValid(baseCtx({ repoRoot: repo }));
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations[0].path).toBe(".github/agentic-policy.json");
    expect(r.violations[0].remediation).toMatch(/npm run entropy:check/);
  });

  it("fails when the policy or loader is missing", () => {
    const repo = makeTmpRepo();
    const r = entropy.rulePolicyValid(baseCtx({ repoRoot: repo }));
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations[0].evidence).toEqual({ missing: true });
  });
});

// ---------------------------------------------------------------------------
// Rule: workflow_sources_compiled
// ---------------------------------------------------------------------------

describe("entropy rule — workflow_sources_compiled", () => {
  const inv = (compiled: boolean) => [
    {
      id: "demo",
      sourcePath: ".github/workflows/demo.md",
      lockPath: ".github/workflows/demo.lock.yml",
      active: true,
      compiled,
    },
  ];

  it("passes when every active source is compiled and support files exist", () => {
    const repo = makeTmpRepo();
    write(repo, ".github/workflows/agentic_commands.yml", "on: {}\n");
    const r = entropy.ruleWorkflowSourcesCompiled(
      baseCtx({
        repoRoot: repo,
        inventory: inv(true),
        requiredSupportFiles: [".github/workflows/agentic_commands.yml"],
      }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });

  it("fails when an active source has no compiled lock", () => {
    const repo = makeTmpRepo();
    const r = entropy.ruleWorkflowSourcesCompiled(
      baseCtx({ repoRoot: repo, inventory: inv(false), requiredSupportFiles: [] }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations[0].path).toBe(".github/workflows/demo.md");
    expect(r.violations[0].evidence).toEqual({
      missingLock: ".github/workflows/demo.lock.yml",
    });
  });

  it("fails when a required generated support file is missing", () => {
    const repo = makeTmpRepo();
    const r = entropy.ruleWorkflowSourcesCompiled(
      baseCtx({
        repoRoot: repo,
        inventory: inv(true),
        requiredSupportFiles: [".github/workflows/agentic_commands.yml"],
      }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations[0].evidence).toEqual({
      missingGeneratedSupportFile: true,
    });
  });

  it("requires cache-memory maintenance support when configured", () => {
    const repo = makeTmpRepo();
    write(repo, ".github/workflows/agentic_commands.yml", "on: {}\n");
    const r = entropy.ruleWorkflowSourcesCompiled(
      baseCtx({
        repoRoot: repo,
        inventory: inv(true),
        requiredSupportFiles: [
          ".github/workflows/agentic_commands.yml",
          ".github/workflows/agentics-maintenance.yml",
        ],
      }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations[0].path).toBe(
      ".github/workflows/agentics-maintenance.yml",
    );
  });
});

// ---------------------------------------------------------------------------
// Rule: doc_references_resolve
// ---------------------------------------------------------------------------

describe("entropy rule — doc_references_resolve", () => {
  it("passes when all local references resolve and ignores external/fenced", () => {
    const repo = makeTmpRepo();
    write(repo, "target.md", "# target\n");
    write(
      repo,
      "doc.md",
      "See [ok](./target.md) and [ext](https://example.com).\n\n```\n[fenced](./missing.md)\n```\n",
    );
    const r = entropy.ruleDocReferencesResolve(
      baseCtx({ repoRoot: repo, docSurfaces: ["doc.md"] }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });

  it("fails on a broken local file reference", () => {
    const repo = makeTmpRepo();
    write(repo, "doc.md", "Broken [x](./nope.md).\n");
    const r = entropy.ruleDocReferencesResolve(
      baseCtx({ repoRoot: repo, docSurfaces: ["doc.md"] }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations[0].evidence.missingReference).toBe("./nope.md");
  });

  it("ignores GitHub web-relative escapes above the repo root", () => {
    const repo = makeTmpRepo();
    write(repo, "doc.md", "Issues live at [tracker](../../issues).\n");
    const r = entropy.ruleDocReferencesResolve(
      baseCtx({ repoRoot: repo, docSurfaces: ["doc.md"] }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });
});

// ---------------------------------------------------------------------------
// Rule: workflow_imports_exist
// ---------------------------------------------------------------------------

describe("entropy rule — workflow_imports_exist", () => {
  const source = (imports: string) =>
    `---\non:\n  workflow_dispatch:\n${imports}---\n\n# body\n`;

  it("passes when every declared import resolves (block + inline)", () => {
    const repo = makeTmpRepo();
    write(repo, ".github/agents/role.md", "# role\n");
    write(
      repo,
      ".github/workflows/wf.md",
      source("imports:\n  - .github/agents/role.md\n"),
    );
    const r = entropy.ruleWorkflowImportsExist(
      baseCtx({
        repoRoot: repo,
        inventory: [{ id: "wf", sourcePath: ".github/workflows/wf.md" }],
      }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });

  it("fails when a declared import is missing", () => {
    const repo = makeTmpRepo();
    write(
      repo,
      ".github/workflows/wf.md",
      source("imports:\n  - .github/agents/ghost.md\n"),
    );
    const r = entropy.ruleWorkflowImportsExist(
      baseCtx({
        repoRoot: repo,
        inventory: [{ id: "wf", sourcePath: ".github/workflows/wf.md" }],
      }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations[0].evidence.missingImport).toBe(
      ".github/agents/ghost.md",
    );
  });

  it("parses an inline array imports list", () => {
    expect(
      entropy.parseImports(
        `---\nimports: [".github/agents/a.md", ".github/agents/b.md"]\non:\n  workflow_dispatch:\n---\n`,
      ),
    ).toEqual([".github/agents/a.md", ".github/agents/b.md"]);
  });
});

// ---------------------------------------------------------------------------
// Rule: duplicated_policy_literals
// ---------------------------------------------------------------------------

describe("entropy rule — duplicated_policy_literals", () => {
  it("flags a verbatim policy clause copied into prose", () => {
    const repo = makeTmpRepo();
    const literal = "^src/(?:agent|backtest|db|guardrails|tools|trading)/";
    write(repo, "docs/x.md", `Routing uses \`${literal}\` directly.\n`);
    const r = entropy.ruleDuplicatedPolicyLiterals(
      baseCtx({
        repoRoot: repo,
        proseSurfaces: ["docs/x.md"],
        policyLiterals: [literal],
      }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.check.severity).toBe(entropy.ADVISORY);
    expect(r.violations[0].evidence.duplicatedLiteral).toBe(literal);
  });

  it("passes when no policy clause is duplicated", () => {
    const repo = makeTmpRepo();
    write(repo, "docs/x.md", "This references the canonical policy file only.\n");
    const r = entropy.ruleDuplicatedPolicyLiterals(
      baseCtx({
        repoRoot: repo,
        proseSurfaces: ["docs/x.md"],
        policyLiterals: ["^src/(?:agent|trading)/"],
      }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });

  it("excludes ordinary file paths from the literal set", () => {
    const literals = entropy.collectPolicyLiterals(
      JSON.parse(
        fs.readFileSync(path.join(root, ".github/agentic-policy.json"), "utf8"),
      ),
    );
    expect(literals).not.toContain("src/proxy.ts");
    expect(literals).not.toContain(".env.example");
    expect(literals.some((l) => l.startsWith("^"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rules sourced from MonitorOps (unknown when absent)
// ---------------------------------------------------------------------------

describe("entropy rule — opportunity_wip_over_cap (MonitorOps)", () => {
  it("is unknown when no snapshot is supplied", () => {
    const r = entropy.ruleOpportunityWipOverCap(baseCtx({ snapshot: null }));
    expect(r.check.status).toBe(entropy.UNKNOWN);
    expect(r.violations).toHaveLength(0);
  });

  it("fails when WIP is at or over the configured cap", () => {
    const r = entropy.ruleOpportunityWipOverCap(
      baseCtx({ snapshot: snapshotFixture }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations[0].evidence).toEqual({
      openActionableOpportunities: 22,
      cap: 20,
    });
  });

  it("passes when WIP is below the cap", () => {
    const r = entropy.ruleOpportunityWipOverCap(
      baseCtx({
        snapshot: { issues: { openActionableOpportunities: 3, wipCap: 20 } },
      }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });
});

describe("entropy rule — workflow_telemetry_coverage (MonitorOps)", () => {
  it("is unknown when no snapshot is supplied", () => {
    const r = entropy.ruleWorkflowTelemetryCoverage(baseCtx({ snapshot: null }));
    expect(r.check.status).toBe(entropy.UNKNOWN);
  });

  it("fails on repeated failures and a coverage gap from the snapshot", () => {
    const r = entropy.ruleWorkflowTelemetryCoverage(
      baseCtx({ snapshot: snapshotFixture }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    const ids = r.violations.map((v) => v.evidence.breach || "coverage-gap");
    expect(ids).toContain("repeated_workflow_failure");
  });

  it("passes when coverage is complete and no failures are present", () => {
    const r = entropy.ruleWorkflowTelemetryCoverage(
      baseCtx({
        snapshot: {
          telemetry: { activeWorkflows: 3, workflowsWithCostData: 3 },
          thresholds: { breaches: [] },
        },
      }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });
});

// ---------------------------------------------------------------------------
// Rule: architecture_boundary_hotspots + no_prohibited_live_executor
// ---------------------------------------------------------------------------

describe("entropy rule — architecture_boundary_hotspots", () => {
  it("flags deterministic trading code importing an agent/model module", () => {
    const repo = makeTmpRepo();
    write(repo, "src/trading/x.ts", 'import { z } from "@/agent/decision";\n');
    const r = entropy.ruleArchitectureBoundaryHotspots(
      baseCtx({ repoRoot: repo, tradingSources: ["src/trading/x.ts"] }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.check.severity).toBe(entropy.ADVISORY);
  });

  it("passes clean trading/decision modules", () => {
    const repo = makeTmpRepo();
    write(repo, "src/trading/x.ts", 'import { db } from "@/db";\n');
    const r = entropy.ruleArchitectureBoundaryHotspots(
      baseCtx({ repoRoot: repo, tradingSources: ["src/trading/x.ts"] }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });
});

describe("entropy rule — no_prohibited_live_executor", () => {
  it("passes the real repository (no live executor in v2)", () => {
    const r = entropy.ruleNoProhibitedLiveExecutor(
      baseCtx({ allSources: ["src/trading/paper-executor.ts"] }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });

  it("fails when a live-executor source or safe-trade tool exists", () => {
    const repo = makeTmpRepo();
    write(repo, "src/tools/safe-trade.ts", "export const x = 1;\n");
    const r = entropy.ruleNoProhibitedLiveExecutor(
      baseCtx({ repoRoot: repo, allSources: ["src/trading/live-executor.ts"] }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.check.severity).toBe(entropy.ZERO_TOLERANCE);
    const paths = r.violations.map((v) => v.path);
    expect(paths).toContain("src/trading/live-executor.ts");
    expect(paths).toContain("src/tools/safe-trade.ts");
  });
});

// ---------------------------------------------------------------------------
// Rule: source_file_size_hotspots + todo_markers
// ---------------------------------------------------------------------------

describe("entropy rule — source_file_size_hotspots", () => {
  it("flags files over the documented advisory threshold, largest first", () => {
    const repo = makeTmpRepo();
    write(repo, "src/big.ts", "x\n".repeat(30));
    write(repo, "src/bigger.ts", "y\n".repeat(60));
    write(repo, "src/small.ts", "z\n".repeat(5));
    const r = entropy.ruleSourceFileSizeHotspots(
      baseCtx({
        repoRoot: repo,
        appSources: ["src/big.ts", "src/bigger.ts", "src/small.ts"],
        lineThreshold: 20,
      }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations.map((v) => v.path)).toEqual(["src/bigger.ts", "src/big.ts"]);
  });

  it("passes when no file exceeds the threshold", () => {
    const repo = makeTmpRepo();
    write(repo, "src/small.ts", "z\n".repeat(5));
    const r = entropy.ruleSourceFileSizeHotspots(
      baseCtx({ repoRoot: repo, appSources: ["src/small.ts"], lineThreshold: 500 }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });
});

describe("entropy rule — todo_markers", () => {
  it("flags conventional annotations but ignores prose mentions", () => {
    const repo = makeTmpRepo();
    write(
      repo,
      "src/a.ts",
      "// TODO: fix\nconst todoList = [];\n/* FIXME(user) */\nconst hacky = 1;\n",
    );
    const r = entropy.ruleTodoMarkers(
      baseCtx({ repoRoot: repo, markerSources: ["src/a.ts"] }),
    );
    expect(r.check.status).toBe(entropy.FAIL);
    expect(r.violations.map((v) => v.evidence.line)).toEqual([1, 3]);
  });

  it("passes source with no marker annotations", () => {
    const repo = makeTmpRepo();
    write(repo, "src/a.ts", "const x = 1;\n");
    const r = entropy.ruleTodoMarkers(
      baseCtx({ repoRoot: repo, markerSources: ["src/a.ts"] }),
    );
    expect(r.check.status).toBe(entropy.PASS);
  });
});

// ---------------------------------------------------------------------------
// Rule: generated_doc_markers_present
// ---------------------------------------------------------------------------

describe("entropy rule — generated_doc_markers_present", () => {
  it("passes on the real repository", () => {
    const r = entropy.ruleGeneratedDocMarkersPresent(baseCtx());
    expect(r.check.status).toBe(entropy.PASS);
  });

  it("fails when the markers are missing", () => {
    const repo = makeTmpRepo();
    write(repo, "docs/agentic-workflows-map.md", "# no markers here\n");
    const r = entropy.ruleGeneratedDocMarkersPresent(baseCtx({ repoRoot: repo }));
    expect(r.check.status).toBe(entropy.FAIL);
  });
});

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

describe("entropy dimensions", () => {
  it("rolls each dimension up from its member checks without a vanity score", () => {
    const checks = [
      { ruleId: "policy_valid", status: "pass" },
      { ruleId: "duplicated_policy_literals", status: "fail" },
      { ruleId: "opportunity_wip_over_cap", status: "unknown" },
    ];
    const violations = [{ ruleId: "duplicated_policy_literals", path: "docs/x.md" }];
    const dims = entropy.buildDimensions(checks, violations);
    const byId = Object.fromEntries(dims.map((d) => [d.id, d.status]));
    expect(byId.policy_consistency).toBe("fail");
    expect(byId.backlog_hygiene).toBe("unknown");
    // Every declared dimension is represented; no numeric aggregate is emitted.
    expect(dims.map((d) => d.id).sort()).toEqual(
      entropy.DIMENSIONS.map((d) => d.id).sort(),
    );
    expect(dims.some((d) => "score" in d)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Material hash determinism + baseline delta + marker precedence + cache miss
// ---------------------------------------------------------------------------

describe("entropy — material hash determinism", () => {
  it("is stable across collection instants with identical findings", () => {
    const a = entropy.collect({
      repoRoot: root,
      now: new Date("2026-08-10T00:15:37Z"),
    }).manifest;
    const b = entropy.collect({
      repoRoot: root,
      now: new Date("2026-08-10T09:59:59Z"),
    }).manifest;
    expect(a.collectedAt).not.toBe(b.collectedAt);
    expect(a.materialHash).toBe(b.materialHash);
    expect(entropy.computeMaterialHash(a)).toBe(entropy.computeMaterialHash(b));
  });

  it("changes when a violation set changes", () => {
    const base = entropy.buildManifest(baseCtx());
    const changed = entropy.buildManifest(
      baseCtx({ allSources: ["src/tools/live-executor.ts"] }),
    );
    expect(changed.materialHash).not.toBe(base.materialHash);
  });
});

describe("entropy — baseline delta and marker precedence", () => {
  const issues = [
    { number: 1, createdAt: "2026-08-01T00:00:00Z", body: `x\n<!-- entropy-state-hash: ${"a".repeat(64)} -->` },
    { number: 2, createdAt: "2026-08-08T00:00:00Z", body: `y\n<!-- entropy-state-hash: ${"b".repeat(64)} -->` },
  ];

  it("reads the newest published hash from report issue markers", () => {
    expect(entropy.readPublishedHash(issues)).toBe("b".repeat(64));
    expect(entropy.readPublishedHash([])).toBeNull();
  });

  it("treats the published hash as authoritative over any cached hash", () => {
    const decision = entropy.decideChange({
      currentHash: "b".repeat(64),
      publishedHash: "b".repeat(64),
      cachedManifest: { materialHash: "deadbeef", violations: [] },
      currentManifest: { violations: [] },
    });
    expect(decision.changed).toBe(false);
  });

  it("does not suppress a report on a cache miss", () => {
    const decision = entropy.decideChange({
      currentHash: "abc",
      publishedHash: null,
      cachedManifest: null,
      currentManifest: { violations: [] },
    });
    expect(decision.changed).toBe(true);
    expect(decision.cacheHit).toBe(false);
  });

  it("computes an added/removed violation delta only against the published cache", () => {
    const decision = entropy.decideChange({
      currentHash: "new",
      publishedHash: "old",
      cachedManifest: {
        materialHash: "old",
        violations: [{ ruleId: "r", path: "a" }],
      },
      currentManifest: {
        violations: [{ ruleId: "r", path: "b" }],
      },
    });
    expect(decision.cacheHit).toBe(true);
    expect(decision.delta).toEqual({ added: ["r::b"], removed: ["r::a"] });
  });
});

// ---------------------------------------------------------------------------
// Report decision — noop vs one issue (shouldReport)
// ---------------------------------------------------------------------------

describe("entropy — report decision (noop vs one issue)", () => {
  it("computes shouldReport=false when the published hash matches (noop)", () => {
    const first = entropy.collect({ repoRoot: root }).manifest;
    const currentHash = first.materialHash as string;
    const runner = (_cmd: string, args: string[]) => {
      expect(_cmd).toBe("gh");
      expect(args.join(" ")).toContain("in:title");
      return {
        status: 0,
        stdout: JSON.stringify([
          { number: 9, createdAt: "2026-08-09T00:00:00Z", body: `r\n<!-- entropy-state-hash: ${currentHash} -->` },
        ]),
        stderr: "",
      };
    };
    const { manifest } = entropy.collect({
      repoRoot: root,
      reportTitlePrefix: "[factory-entropy] ",
      runner,
    });
    expect(manifest.baselineDelta).toMatchObject({ changed: false });
    expect((manifest.summary as Record<string, unknown>).shouldReport).toBe(false);
  });

  it("computes shouldReport=true on a new baseline with actionable findings", () => {
    const { manifest } = entropy.collect({ repoRoot: root });
    // The real repo has advisory findings, so it is actionable, and with no
    // published baseline the run reports.
    expect((manifest.summary as Record<string, unknown>).actionable).toBe(true);
    expect((manifest.baselineDelta as Record<string, unknown>).changed).toBe(true);
    expect((manifest.summary as Record<string, unknown>).shouldReport).toBe(true);
  });

  it("computes shouldReport=false when there are no actionable violations", () => {
    const manifest = entropy.buildManifest(
      baseCtx({
        // A context with no file-reading rules tripping and no snapshot yields
        // only pass/unknown checks and zero violations.
        inventory: [],
        requiredSupportFiles: [],
        docSurfaces: [],
        proseSurfaces: [],
        appSources: [],
        markerSources: [],
        allSources: [],
        tradingSources: [],
      }),
    );
    // policy_valid + generated markers pass against the real root; no violations.
    expect(manifest.violations).toHaveLength(0);
    expect((manifest.summary as Record<string, unknown>).actionable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLI: path safety, command failure, and GitHub isolation
// ---------------------------------------------------------------------------

describe("entropy — CLI (no GitHub access)", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entropy-cli-"));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a versioned manifest without contacting GitHub", () => {
    const out = path.join(tmpDir, "manifest.json");
    const rc = entropy.main(["--out", out], {
      repoRoot: root,
      runner: () => {
        throw new Error("runner must not be called without --report-prefix");
      },
    });
    expect(rc).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(manifest.schemaVersion).toBe(entropy.MANIFEST_SCHEMA_VERSION);
    expect(Array.isArray(manifest.checks)).toBe(true);
    expect(manifest).toHaveProperty("materialHash");
    expect(manifest).toHaveProperty("dimensions");
    expect(manifest).toHaveProperty("baselineDelta");
  });

  it("rejects an output path outside /tmp/gh-aw in workflow mode", () => {
    const rc = entropy.main(
      ["--out", "/etc/passwd", "--workflow-mode"],
      { repoRoot: root },
    );
    expect(rc).toBe(2);
  });

  it("fails loud when the report-issue read fails (fail closed, no suppression)", () => {
    const rc = entropy.main(
      ["--out", path.join(tmpDir, "fail.json"), "--report-prefix", "[factory-entropy] "],
      {
        repoRoot: root,
        runner: () => ({ status: 1, stdout: "", stderr: "simulated gh failure" }),
      },
    );
    expect(rc).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "fail.json"))).toBe(false);
  });

  it("throws loud when the supplied MonitorOps snapshot path is missing", () => {
    const rc = entropy.main(
      ["--snapshot", path.join(tmpDir, "absent.json"), "--out", path.join(tmpDir, "x.json")],
      { repoRoot: root },
    );
    expect(rc).toBe(1);
  });

  it("exits non-zero on --check only for zero-tolerance failures", () => {
    // The real repo passes all zero-tolerance rules → --check succeeds despite
    // advisory findings.
    const rc = entropy.main(["--check"], { repoRoot: root });
    expect(rc).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Workflow contract: report-only, single output, safe outputs
// ---------------------------------------------------------------------------

describe("entropy — harness-entropy workflow contract", () => {
  const source = fs.readFileSync(
    path.join(root, ".github/workflows/harness-entropy.md"),
    "utf8",
  );
  const lock = fs.readFileSync(
    path.join(root, ".github/workflows/harness-entropy.lock.yml"),
    "utf8",
  );

  it("runs weekly with a manual dispatch path", () => {
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("schedule: weekly on monday");
  });

  it("uses cache-memory with 90-day retention", () => {
    expect(source).toContain("cache-memory:");
    expect(source).toContain("retention-days: 90");
  });

  it("exposes only the two trusted collectors and cat on the bash allowlist", () => {
    expect(source).toContain('"node scripts/agentic/collect-factory-health.cjs *"');
    expect(source).toContain('"node scripts/agentic/collect-agentic-entropy.cjs *"');
    expect(source).toContain('"cat /tmp/gh-aw/factory-health.json"');
    expect(source).toContain('"cat /tmp/gh-aw/entropy-manifest.json"');
  });

  it("configures exactly one report issue with close-older, expiry, and no mentions", () => {
    expect(source).toContain('title-prefix: "[factory-entropy] "');
    expect(source).toContain("max: 1");
    expect(source).toContain("close-older-issues: true");
    expect(source).toContain("expires: 90d");
    expect(source).toContain("mentions: false");
    expect(source).toContain("allowed-github-references: []");
    expect(source).toContain("noop:");
  });

  it("embeds the entropy-state-hash marker instruction", () => {
    expect(source).toContain("<!-- entropy-state-hash: MATERIAL_STATE_HASH -->");
  });

  it("is report-only: no create-pull-request, push, edit, or deletion output", () => {
    // Scope the forbidden-output check to the frontmatter (the prose Rules
    // section legitimately explains that these outputs are absent).
    const fmEnd = source.indexOf("\n---", 3);
    const frontmatter = source.slice(0, fmEnd);
    for (const forbidden of [
      "create-pull-request",
      "push-to-pull-request-branch",
      "push-to-branch",
      "update-issue",
    ]) {
      expect(frontmatter).not.toContain(forbidden);
    }
    // The compiled lock only declares create_issue + noop safe-output tools.
    expect(lock).toContain("create_issue");
    expect(lock).not.toContain('"create_pull_request":');
    expect(lock).not.toContain('"push_to_pull_request_branch":');
  });

  it("compiles to a single create-issue safe output (max 1)", () => {
    expect(lock).toContain('"max":1');
    expect(lock).toContain('"title_prefix":"[factory-entropy] "');
  });
});
