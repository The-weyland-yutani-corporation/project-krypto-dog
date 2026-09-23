import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import { makeGithub, signalPayload, NOW, SHA, REPOSITORY, issue } from "./fixtures/signals";

type Data = Record<string, unknown>;
type Source = { completeness: string; records: number; reason: string | null };
type Receipt = { series: string; status: string; completeness: string; materialHash: string; report?: Data; reason: string };
const root = path.resolve(__dirname, "../..");
const watchdog = jest.requireActual<{
  collectWatchdog(options: unknown): Promise<{ receipts: Receipt[]; errors: unknown[]; discoveryEligible: boolean }>;
  publishWatchdog(options: unknown): Promise<Data[]>;
  inspectReceiptRun(options: unknown): Promise<{ attempt: number; sha: string }>;
  mergeDiscoverySignals(options: unknown): void;
  authorizeWatchdogEvent(options: unknown): Promise<{ allowed: boolean; reason: string }>;
  signalCandidates(snapshot: unknown, manifest: unknown, repository: string): Data[];
  resolveWatchdogMode(context: unknown): string;
}>("../../scripts/agentic/factory-watchdog.cjs");
const factory = jest.requireActual<{
  DEFAULT_FAILING_CONCLUSIONS: string[];
  collect(options: unknown): { snapshot: Data };
  computeMaterialHash(snapshot: unknown): string;
  buildSnapshot(options: unknown): Data;
  evaluateThresholds(snapshot: unknown, policy: unknown, watermarks: unknown): { watermarks: Data; breaches: Data[] };
}>("../../scripts/agentic/collect-factory-health.cjs");
const reader = jest.requireActual<{
  readPages(runner: unknown, route: string, key: unknown, options: unknown): { data: unknown[]; source: Source };
  normalizeWorkflowPath(value: unknown): unknown;
}>("../../scripts/agentic/factory-read.cjs");
const observation = jest.requireActual<{
  MAX_DETAIL_ISSUES: number;
  readFactoryState(options: unknown): Promise<{ state: Data; sources: Data; issues: unknown[]; details: Data }>;
  readSignalOutcomes(options: unknown): Promise<{ verifiedSubstantive: number | null; reason: string; items: Data[]; paperMetrics: null }>;
}>("../../scripts/agentic/factory-observation.cjs");
const contract = jest.requireActual<{
  fingerprintFor(source: Record<string, string>): string;
  proposalBody(signal: unknown, proposal: unknown): string;
}>("../../scripts/agentic/signal-contract.cjs");
const usage = jest.requireActual<{
  appliedOutcomes(text: string): { succeeded: number; failed: number; noop: number } | null;
}>("../../scripts/agentic/factory-usage.cjs");

function nativeRunner(fixture: ReturnType<typeof makeGithub>) {
  return (_command: string, args: string[]) => {
    const joined = args.join(" ");
    let data: unknown;
    if (joined.includes("/actions/workflows")) data = { workflows: [
      { path: ".github/workflows/ci.yml", state: "active" },
      { path: ".github/workflows/agentic-evals.yml", state: "active" },
    ] };
    else if (joined.includes("/actions/runs?")) data = { workflow_runs: [fixture.failedRun] };
    else if (joined.includes("/issues?")) data = fixture.issues;
    else if (joined.includes("pr list")) data = [];
    else throw new Error(`unexpected native command: ${joined}`);
    return { status: 0, stdout: JSON.stringify(data), stderr: "" };
  };
}

describe("model-independent native health and canonical publication", () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "factory-watchdog-")); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it("publishes machine-readable canonical failure when model execution fails, including while paused", async () => {
    const fixture = makeGithub();
    fixture.issues[0].labels = ["factory-control", "factory-mode:paused"];
    fixture.failedRun.path = ".github/workflows/daily-repo-status.lock.yml";
    const result = await watchdog.collectWatchdog({
      github: fixture.github, owner: "example", repo: "krypto", now: NOW,
      directory, repoRoot: root, runner: nativeRunner(fixture), mode: "daily",
      sourceRunId: 310, runId: 320, evidenceReader: null,
    });
    expect(result.errors).toEqual([]);
    expect(result.receipts[0]).toMatchObject({
      status: "failed", completeness: "complete", reason: "monitored-workflow-failed",
      report: { factory: { mode: { mode: "paused" }, workState: "paused" },
        outcomes: { verifiedSubstantive: null, reason: "dev-evidence-reader-unavailable" } },
    });
    expect(result.discoveryEligible).toBe(false);
    expect(fs.existsSync(path.join(directory, "factory-health.json"))).toBe(true);
    const options = { github: fixture.github, owner: "example", repo: "krypto", directory, apply: true, now: NOW };
    expect(await watchdog.publishWatchdog(options)).toMatchObject([{ action: "created" }]);
    expect(fixture.issues.at(-1)?.body).toContain("<!-- factory-report:v1 daily -->");
    expect(fixture.issues.at(-1)?.body).toContain("monitored-workflow-failed");
    expect(await watchdog.publishWatchdog(options)).toMatchObject([{ action: "unchanged" }]);
    expect(fixture.github.rest.issues.create).toHaveBeenCalledTimes(1);
  });

  it("publishes a minimal canonical failure if collection tooling never produced an artifact", async () => {
    const fixture = makeGithub();
    await watchdog.publishWatchdog({ github: fixture.github, owner: "example", repo: "krypto", directory, apply: true, now: NOW });
    expect(fixture.issues.at(-1)?.body).toContain("collection-receipt-unavailable");
    expect(fixture.issues.at(-1)?.body).toContain("unavailable");
  });

  it.each([
    { eventName: "schedule", payload: { schedule: "30 7 * * 1" } },
    { eventName: "workflow_dispatch", payload: { inputs: { mode: "governance" } } },
  ])("publishes a missing weekly receipt to every weekly series for %j", async (context) => {
    const fixture = makeGithub();
    const mode = watchdog.resolveWatchdogMode(context);
    expect(mode).toBe("governance");
    const options = { github: fixture.github, owner: "example", repo: "krypto", directory, mode, apply: true, now: NOW };
    expect(await watchdog.publishWatchdog(options)).toMatchObject([
      { action: "created" }, { action: "created" }, { action: "created" },
    ]);
    for (const series of ["governance", "entropy", "corrections"]) {
      expect(fixture.issues.some((item) => item.body.includes(`<!-- factory-report:v1 ${series} -->`) &&
        item.body.includes("collection-receipt-unavailable"))).toBe(true);
    }
    expect(fixture.issues.some((item) => item.body.includes("<!-- factory-report:v1 daily -->"))).toBe(false);
    expect(await watchdog.publishWatchdog(options)).toMatchObject([
      { action: "unchanged" }, { action: "unchanged" }, { action: "unchanged" },
    ]);
    expect(fixture.github.rest.issues.create).toHaveBeenCalledTimes(3);
  });

  it("preserves daily mode and rejects invalid explicit reporting modes", () => {
    expect(watchdog.resolveWatchdogMode({ eventName: "schedule", payload: { schedule: "15 7 * * *" } })).toBe("daily");
    expect(watchdog.resolveWatchdogMode({ eventName: "workflow_run", payload: {} })).toBe("daily");
    expect(() => watchdog.resolveWatchdogMode({
      eventName: "workflow_dispatch", payload: { inputs: { mode: "invented" } },
    })).toThrow("invalid-watchdog-mode");
  });

  it("distinguishes no work, budget exhaustion, conflicting goals and infrastructure failure", async () => {
    const fixture = makeGithub();
    const options = { github: fixture.github, owner: "example", repo: "krypto", now: NOW };
    expect((await observation.readFactoryState(options)).state.workState).toBe("no-work");
    fixture.issues[1].body = fixture.issues[1].body.replace("### Assignment budget\n\n12", "### Assignment budget\n\n0");
    expect((await observation.readFactoryState(options)).state.workState).toBe("budget-exhausted");
    fixture.issues.push({ ...fixture.issues[1], number: 274 });
    expect((await observation.readFactoryState(options)).state.workState).toBe("conflicting-goals");
    fixture.failures.set("GET /repos/{owner}/{repo}/issues", 503);
    expect((await observation.readFactoryState(options)).state).toMatchObject({
      workState: "infrastructure-failure", capacity: { inFlight: null, budgetUsed: null },
    });
  });

  it("reports partial APIs rather than unread zero/pass", () => {
    const result = reader.readPages(() => ({ status: 0, stdout: JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id }))), stderr: "" }),
      "repos/example/krypto/issues", null, { maxPages: 2, now: NOW });
    expect(result.data).toHaveLength(200);
    expect(result.source).toMatchObject({ completeness: "partial", reason: "page-limit-reached" });
    const fixture = makeGithub();
    const normal = nativeRunner(fixture);
    const { snapshot } = factory.collect({
      repoRoot: root, repository: REPOSITORY, mode: "daily", now: NOW,
      runner: (command: string, args: string[]) => args.join(" ").includes("/issues?")
        ? { status: 1, stdout: "", stderr: "HTTP 503" } : normal(command, args),
    });
    expect(snapshot).toMatchObject({ collection: { completeness: "partial" }, issues: { openedInWindow: null, openActionableOpportunities: null } });
  });

  it("observes older control and approval timelines before bounded work detail without granting incomplete capacity", async () => {
    const fixture = makeGithub();
    fixture.issues.unshift(...Array.from({ length: observation.MAX_DETAIL_ISSUES + 1 }, (_, index) =>
      issue(1000 + index, ["agentic-factory"])));
    const result = await observation.readFactoryState({
      github: fixture.github, owner: "example", repo: "krypto", now: NOW,
    });
    expect(result.state).toMatchObject({
      mode: { mode: "active", reason: "ok", controlIssue: 233 },
      goals: { resolution: "ok", active: { number: 248 } },
      capacity: { completeness: "partial", inFlight: null, budgetUsed: null },
      workState: "observation-incomplete",
    });
    expect(result.sources.details).toMatchObject({ completeness: "partial", reason: "issue-detail-limit-reached" });
    const timelines = fixture.github.request.mock.calls.filter(([route]) => route.endsWith("/timeline"));
    expect(timelines).toHaveLength(observation.MAX_DETAIL_ISSUES);
    expect(timelines.slice(0, 2).map(([, params]) => params?.issue_number)).toEqual([233, 248]);
  });

  it("normalizes persisted paths as well as identities so equivalent native observations do not churn report hashes", async () => {
    const fixture = makeGithub();
    const options = {
      github: fixture.github, owner: "example", repo: "krypto", now: NOW, directory, repoRoot: root,
      runner: nativeRunner(fixture), mode: "daily", sourceRunId: 310, evidenceReader: null,
    };
    const plain = await watchdog.collectWatchdog(options);
    fixture.failedRun.path += "@refs/heads/main";
    const suffixed = await watchdog.collectWatchdog(options);
    expect(plain.errors).toEqual([]);
    expect(suffixed.errors).toEqual([]);
    expect(suffixed.receipts[0].materialHash).toBe(plain.receipts[0].materialHash);
    expect(suffixed.receipts[0].report).toMatchObject({
      monitoredRun: { workflow: ".github/workflows/ci.yml" },
      workflows: expect.arrayContaining([expect.objectContaining({
        id: "ci", usage: expect.objectContaining({ evidence: [expect.objectContaining({ path: ".github/workflows/ci.yml" })] }),
      })]),
    });
  });

  it.each(["", "@refs/heads/main", "@refs/tags/v2.1.0", "@refs/pull/600/merge"])(
    "emits the same canonical signal identity for a native workflow path with suffix %j",
    (suffix) => {
      const fixture = makeGithub();
      fixture.failedRun.path += suffix;
      const { snapshot } = factory.collect({
        repoRoot: root, repository: REPOSITORY, mode: "daily", now: NOW, runner: nativeRunner(fixture),
      });
      const candidates = watchdog.signalCandidates(snapshot, null, REPOSITORY);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        fingerprint: signalPayload(contract.fingerprintFor).signal.fingerprint,
        source: { key: ".github/workflows/ci.yml:failure", sha: SHA },
      });
    },
  );

  it.each([
    ".github/workflows/ci.yml@notes",
    ".github/workflows/ci@nightly.yml",
    ".github/workflows/ci.yml@refs/",
    ".github/workflows/ci.yml@refs/heads/",
    ".github/workflows/ci.txt@refs/heads/main",
    null,
    undefined,
  ])("preserves path text that is not a documented workflow ref suffix: %j", (value) => {
    expect(reader.normalizeWorkflowPath(value)).toBe(value);
  });

  it("hashes gross churn, exact cost and closed windows, not just net issue change", () => {
    const base = { schemaVersion: 1, mode: "daily", window: { start: "a", end: "b" },
      issues: { openedInWindow: 2, closedInWindow: 2, netOpened: 0 }, workflows: [{ id: "ci", usage: { aiCredits: 1 } }] };
    expect(factory.computeMaterialHash(base)).not.toBe(factory.computeMaterialHash({
      ...base, issues: { openedInWindow: 3, closedInWindow: 3, netOpened: 0 },
    }));
    expect(factory.computeMaterialHash(base)).not.toBe(factory.computeMaterialHash({ ...base, window: { start: "b", end: "c" } }));
    expect(factory.computeMaterialHash(base)).not.toBe(factory.computeMaterialHash({ ...base, workflows: [{ id: "ci", usage: { aiCredits: 1.01 } }] }));
  });

  it("does not advance missing-telemetry streaks on same-window replays or unrelated distant windows", () => {
    const snapshot = {
      window: { start: "2026-09-07T00:00:00Z", end: "2026-09-14T00:00:00Z", days: 7 },
      workflows: [{ id: "pm-triage", kind: "gh-aw", usage: { runs: 1, aiCredits: null } }],
    };
    const first = factory.evaluateThresholds(snapshot, {}, {});
    const replay = factory.evaluateThresholds(snapshot, {}, first.watermarks);
    expect(replay.watermarks.missingTelemetryStreak).toBe(1);
    expect(replay.breaches).not.toContainEqual(expect.objectContaining({ id: "telemetry_missing_two_periods" }));
    const next = factory.evaluateThresholds({
      ...snapshot, window: { start: "2026-09-14T00:00:00Z", end: "2026-09-21T00:00:00Z", days: 7 },
    }, {}, first.watermarks);
    expect(next.watermarks.missingTelemetryStreak).toBe(2);
    const distant = factory.evaluateThresholds({
      ...snapshot, window: { start: "2026-10-05T00:00:00Z", end: "2026-10-12T00:00:00Z", days: 7 },
    }, {}, first.watermarks);
    expect(distant.watermarks.missingTelemetryStreak).toBe(1);
  });

  it("reads actual applied safe-output records, preserving unknown when records are not applied", () => {
    expect(usage.appliedOutcomes('{"type":"add-labels","applied_at":"2026-09-15T00:00:00Z"}\n')).toEqual({ succeeded: 1, failed: 0, noop: 0 });
    expect(usage.appliedOutcomes('{"type":"add-labels"}\n')).toBeNull();
    expect(() => usage.appliedOutcomes("{bad json}\n")).toThrow("invalid-safe-output-artifact");
  });

  it("preserves weekly signals through the real bounded discovery handoff", () => {
    const payload = signalPayload(contract.fingerprintFor);
    const sourcePath = path.join(directory, "source.json");
    const outputPath = path.join(directory, "current.json");
    fs.writeFileSync(sourcePath, JSON.stringify({ schemaVersion: 1, observedAt: NOW, signals: [payload.signal] }));
    fs.writeFileSync(outputPath, JSON.stringify({ schemaVersion: 1, observedAt: NOW, signals: [] }));
    watchdog.mergeDiscoverySignals({ sourcePath, outputPath, repository: REPOSITORY, now: NOW });
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8")).signals).toHaveLength(1);
    watchdog.mergeDiscoverySignals({ sourcePath, outputPath, repository: REPOSITORY, now: NOW });
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8")).signals).toHaveLength(1);
    expect(() => watchdog.mergeDiscoverySignals({ sourcePath, outputPath, repository: REPOSITORY, now: "2026-09-18T07:00:00Z" }))
      .toThrow("invalid-watchdog-signal-receipt");
  });

  it.each(["", "@refs/heads/main", "@refs/tags/v2.1.0"])("accepts trusted exact-attempt receipt paths with suffix %j", async (suffix) => {
    const request = jest.fn(async (route: string) => ({
      data: route.endsWith("/jobs")
        ? { jobs: [{ name: "observe", status: "completed", conclusion: "success" }] }
        : { repository: { full_name: REPOSITORY }, head_branch: "main", head_sha: SHA,
          path: `.github/workflows/factory-watchdog.yml${suffix}`, run_attempt: 2, updated_at: NOW },
    }));
    expect(await watchdog.inspectReceiptRun({
      github: { request }, owner: "example", repo: "krypto", runId: 320, defaultBranch: "main", now: NOW,
    })).toEqual({ attempt: 2, sha: SHA });
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
      expect.objectContaining({ attempt_number: 2 }),
    );
  });

  it("does not accept a receipt workflow by discarding unrelated path text", async () => {
    const request = jest.fn(async () => ({ data: {
      repository: { full_name: REPOSITORY }, head_branch: "main", head_sha: SHA,
      path: ".github/workflows/factory-watchdog.yml@notes", run_attempt: 2, updated_at: NOW,
    } }));
    await expect(watchdog.inspectReceiptRun({
      github: { request }, owner: "example", repo: "krypto", runId: 320, defaultBranch: "main", now: NOW,
    })).rejects.toThrow("untrusted-or-stale-watchdog-receipt-run");
  });
});

describe("signal provenance -> genuine dev evidence -> measured outcome", () => {
  async function outcomeFixture() {
    const fixture = makeGithub();
    const payload = signalPayload(contract.fingerprintFor);
    const child = issue(500, ["agentic-factory", "factory:merged", "risk:sensitive"], contract.proposalBody(payload.signal, payload.proposal));
    fixture.issues.push(child);
    fixture.parents.set(child.number, 248);
    fixture.comments.set(child.number, [{
      id: 1, body: '<!-- factory-claim:v1 {"nonce":"100:1:500","owner":"factory","issueNumber":500,"expiresAt":"2026-09-15T10:00:00Z"} -->',
      user: { login: "github-actions[bot]" }, created_at: NOW, updated_at: NOW,
    }]);
    fixture.comments.set(16, [{
      id: 2, user: { login: "github-actions[bot]" }, created_at: NOW, updated_at: NOW,
      body: `<!-- factory-signal-admission:v1 ${JSON.stringify({
        schemaVersion: 1, phase: "native-linked", sourceIssueNumber: 16, issueNumber: 500, goalNumber: 248,
        fingerprint: payload.signal.fingerprint,
        bodySha256: crypto.createHash("sha256").update(child.body).digest("hex"),
      })} -->`,
    }]);
    fixture.pulls.push({
      number: 600, title: "[ai-dev] scoped safety fix", body: "Refs #500\n<!-- factory-claim:100:1:500 -->",
      merged_at: "2026-09-15T06:30:00Z", merge_commit_sha: SHA,
      head: { sha: "b".repeat(40), repo: { full_name: REPOSITORY } }, base: { ref: "main" },
    });

    const observed = await observation.readFactoryState({ github: fixture.github, owner: "example", repo: "krypto", now: NOW });
    return { fixture, observed, child };
  }

  it.each(["unavailable", "pending", "status-only", "wrong-sha"])("never counts %s dev proof as completion", async (variant) => {
    const { fixture, observed } = await outcomeFixture();
    const evidenceReader = variant === "unavailable" ? null : async () => {
      if (variant === "pending") return { outcome: "pending", reason: "dev-proof-unavailable" };
      if (variant === "status-only") return { outcome: "success" };
      return { outcome: "success", receipt: { releaseSha: "c".repeat(40), environmentName: "dev" } };
    };
    const result = await observation.readSignalOutcomes({
      github: fixture.github, owner: "example", repo: "krypto", observation: observed, repoRoot: root,
      window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      evidenceReader,
    });
    if (variant === "unavailable") expect(result.verifiedSubstantive).toBeNull();
    else expect(result.verifiedSubstantive).toBe(0);
    expect(result.items[0]).toMatchObject({ fingerprint: expect.any(String), development: { outcome: "pending" }, measuredOutcome: { status: "pending" } });
    expect(result.paperMetrics).toBeNull();
  });

  describe("optional authoritative reader selection", () => {
    let capabilityRoot: string;
    let capabilityPath: string;
    beforeEach(() => {
      capabilityRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-reader-"));
      capabilityPath = path.join(capabilityRoot, ".github", "scripts", "azure", "dev-evidence.cjs");
      fs.mkdirSync(path.dirname(capabilityPath), { recursive: true });
      fs.writeFileSync(capabilityPath, "exports.readDevEvidence = (input) => input.github.installedEvidenceReader(input);\n");
    });
    afterEach(() => { fs.rmSync(capabilityRoot, { recursive: true, force: true }); });

    it.each([{}, { evidenceReader: undefined }])("auto-loads the installed reader with the unchanged SDK client for %j", async (override) => {
      const { fixture, observed } = await outcomeFixture();
      const installedEvidenceReader = jest.fn(async () => ({ outcome: "pending", reason: "installed-proof-pending" }));
      const github = { ...fixture.github, installedEvidenceReader };
      const result = await observation.readSignalOutcomes({
        github, owner: "example", repo: "krypto", observation: observed, repoRoot: capabilityRoot,
        window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" }, ...override,
      });
      expect(installedEvidenceReader).toHaveBeenCalledTimes(1);
      expect(installedEvidenceReader).toHaveBeenCalledWith({ github, owner: "example", repo: "krypto", sha: SHA, pullNumber: 600 });
      expect(result).toMatchObject({ verifiedSubstantive: 0, reason: "collected" });
      expect(result.items[0]).toMatchObject({ development: { outcome: "pending", reason: "installed-proof-pending" } });
    });

    it("keeps explicit null unavailable even when an authoritative reader is installed", async () => {
      const { fixture, observed } = await outcomeFixture();
      const installedEvidenceReader = jest.fn();
      const result = await observation.readSignalOutcomes({
        github: { ...fixture.github, installedEvidenceReader }, owner: "example", repo: "krypto",
        observation: observed, repoRoot: capabilityRoot, evidenceReader: null,
        window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      });
      expect(installedEvidenceReader).not.toHaveBeenCalled();
      expect(result).toMatchObject({ verifiedSubstantive: null, reason: "dev-evidence-reader-unavailable" });
    });

    it("prefers an explicit reader over the installed capability", async () => {
      const { fixture, observed } = await outcomeFixture();
      const installedEvidenceReader = jest.fn();
      const evidenceReader = jest.fn(async () => ({ outcome: "pending", reason: "injected-proof-pending" }));
      const github = { ...fixture.github, installedEvidenceReader };
      const result = await observation.readSignalOutcomes({
        github, owner: "example", repo: "krypto", observation: observed, repoRoot: capabilityRoot, evidenceReader,
        window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      });
      expect(installedEvidenceReader).not.toHaveBeenCalled();
      expect(evidenceReader).toHaveBeenCalledWith({ github, owner: "example", repo: "krypto", sha: SHA, pullNumber: 600 });
      expect(result.items[0]).toMatchObject({ development: { outcome: "pending", reason: "injected-proof-pending" } });
    });

    it("reports unavailable when auto-loading has no installed capability", async () => {
      fs.unlinkSync(capabilityPath);
      const { fixture, observed } = await outcomeFixture();
      const result = await observation.readSignalOutcomes({
        github: fixture.github, owner: "example", repo: "krypto", observation: observed, repoRoot: capabilityRoot,
        window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      });
      expect(result).toMatchObject({ verifiedSubstantive: null, reason: "dev-evidence-reader-unavailable" });
    });

    it.each([false, 0, "", {}])("rejects invalid explicit reader %j instead of auto-loading", async (evidenceReader) => {
      const { fixture, observed } = await outcomeFixture();
      const installedEvidenceReader = jest.fn();
      await expect(observation.readSignalOutcomes({
        github: { ...fixture.github, installedEvidenceReader }, owner: "example", repo: "krypto",
        observation: observed, repoRoot: capabilityRoot, evidenceReader,
        window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      })).rejects.toThrow("invalid-dev-evidence-reader");
      expect(installedEvidenceReader).not.toHaveBeenCalled();
    });

    it("propagates errors from the auto-loaded reader", async () => {
      const { fixture, observed } = await outcomeFixture();
      const installedEvidenceReader = jest.fn(async () => { throw new Error("installed-proof-api-unavailable"); });
      await expect(observation.readSignalOutcomes({
        github: { ...fixture.github, installedEvidenceReader }, owner: "example", repo: "krypto",
        observation: observed, repoRoot: capabilityRoot,
        window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      })).rejects.toThrow("installed-proof-api-unavailable");
    });
  });

  it("binds genuine delivery to the merged SHA but keeps missing post-metrics pending", async () => {
    const { fixture, observed } = await outcomeFixture();
    const result = await observation.readSignalOutcomes({
      github: fixture.github, owner: "example", repo: "krypto", observation: observed, repoRoot: root,
      window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      evidenceReader: async () => ({ outcome: "success", reason: "validated-by-authoritative-reader",
        receipt: { releaseSha: SHA, environmentName: "dev", artifact: { id: 1, name: "proof", digest: "sha256:fixture" } } }),
    });
    expect(result.verifiedSubstantive).toBe(1);
    expect(result.items[0]).toMatchObject({ issueNumber: 500, pullNumber: 600, mergeSha: SHA,
      measuredOutcome: { status: "pending" } });
  });

  it("propagates real reader errors instead of falling back to status-only success", async () => {
    const { fixture, observed } = await outcomeFixture();
    await expect(observation.readSignalOutcomes({
      github: fixture.github, owner: "example", repo: "krypto", observation: observed, repoRoot: root,
      window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      evidenceReader: async () => { throw new Error("proof-api-unavailable"); },
    })).rejects.toThrow("proof-api-unavailable");
  });

  it("does not attribute a copied marker or changed body to an admitted signal", async () => {
    const { fixture, observed, child } = await outcomeFixture();
    child.body += "\nTampered after admission.";
    const result = await observation.readSignalOutcomes({
      github: fixture.github, owner: "example", repo: "krypto", observation: observed, repoRoot: root,
      window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      evidenceReader: async () => ({ outcome: "success", receipt: { releaseSha: SHA, environmentName: "dev" } }),
    });
    expect(result.verifiedSubstantive).toBe(0);
    expect(result.items[0]).toMatchObject({ development: { outcome: "pending", reason: "signal-admission-proof-unavailable" } });
  });

  it("measures a real independent post-merge success without inventing paper performance", async () => {
    const { fixture, observed } = await outcomeFixture();
    fixture.failedRun.created_at = "2026-09-15T06:45:00Z";
    fixture.failedRun.conclusion = "success";
    const result = await observation.readSignalOutcomes({
      github: fixture.github, owner: "example", repo: "krypto", observation: observed, repoRoot: root,
      window: { start: "2026-09-14T07:00:00Z", end: "2026-09-15T07:00:00Z" },
      evidenceReader: async () => ({ outcome: "success", receipt: { releaseSha: SHA, environmentName: "dev" } }),
    });
    expect(result.items[0]).toMatchObject({ measuredOutcome: { status: "met", observedValue: 0, sha: SHA, synthetic: false, tradingEdge: null } });
    expect(result.paperMetrics).toBeNull();
  });
});

describe("trusted model-independent workflow wiring", () => {
  it("limits CI Doctor triggers to default-branch failures the collector and intake support", () => {
    const source = fs.readFileSync(path.join(root, ".github/workflows/ci-doctor.md"), "utf8");
    const frontmatter = parseYaml(source.split(/^---\s*$/m)[1]);
    const lock = parseYaml(fs.readFileSync(path.join(root, ".github/workflows/ci-doctor.lock.yml"), "utf8"));
    const policyData = JSON.parse(fs.readFileSync(path.join(root, ".github/agentic-policy.json"), "utf8"));
    expect(frontmatter.on.workflow_run.branches).toEqual(["main"]);
    expect(lock.on.workflow_run.branches).toEqual(["main"]);
    expect(frontmatter.if).toContain("github.event.workflow_run.head_branch == github.event.repository.default_branch");
    const conclusions = frontmatter.if.match(/contains\(fromJSON\('([^']+)'\), github\.event\.workflow_run\.conclusion\)/);
    expect(conclusions).not.toBeNull();
    const allowed: string[] = JSON.parse(conclusions![1]);
    expect(allowed.slice().sort()).toEqual(factory.DEFAULT_FAILING_CONCLUSIONS.slice().sort());
    expect(allowed.slice().sort()).toEqual(policyData.conclusions.failing.slice().sort());
    expect(allowed).not.toContain("action_required");
  });

  it("uses a complete GitHub SDK client for real dev-proof readers and exact-attempt artifacts", () => {
    const source = fs.readFileSync(path.join(root, ".github/workflows/factory-watchdog.yml"), "utf8");
    expect(source).toContain("uses: actions/github-script@v9");
    expect(source).toContain("github, context, core, mode:");
    expect(source).toContain("factory-watchdog-receipts-a${{ github.run_attempt }}");
    const workflow = parseYaml(source);
    expect(workflow.jobs.observe.permissions.issues).toBe("read");
    expect(workflow.jobs.publish.permissions.issues).toBe("write");
    expect(workflow.jobs.observe.if).toContain("needs.authorize.outputs.allowed == 'true'");
    expect(workflow.jobs.publish.if).toContain("needs.authorize.outputs.allowed == 'true'");
    expect(workflow.jobs.publish.needs).toContain("authorize");
    expect(workflow.jobs.authorize.outputs.mode).toBe("${{ steps.authorize.outputs.mode }}");
    const publishStep = workflow.jobs.publish.steps.find((step: { name?: string }) =>
      step.name === "Publish owned canonical status or explicit missing-receipt failure");
    expect(publishStep.env.WATCHDOG_MODE).toBe("${{ needs.authorize.outputs.mode }}");
    expect(publishStep.with.script).toContain("mode: process.env.WATCHDOG_MODE");
    expect(workflow.jobs.observe.steps.find((step: { id?: string }) => step.id === "collect").uses).toBe("actions/github-script@v9");
  });

  it.each([
    ["skipped", "Bot", "github-actions[bot]"],
    ["failure", "Bot", "github-actions[bot]"],
    ["skipped", "User", "maintainer-token-owner"],
    ["failure", "User", "maintainer-token-owner"],
  ])("does not let %s command activation under a %s dispatcher trigger writes", async (conclusion, type, login) => {
    const request = jest.fn(async (route: string) => ({
      data: route.endsWith("/jobs") ? { jobs: [
        { name: "pre_activation", status: "completed", conclusion: "success" },
        { name: "activation", status: "completed", conclusion },
      ] } : {
        repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
        head_branch: "main", status: "completed", path: ".github/workflows/opportunity-discovery.lock.yml",
        event: "workflow_dispatch", actor: { type, login }, run_attempt: 1,
      },
    }));
    expect(await watchdog.authorizeWatchdogEvent({
      github: { request }, context: { repo: { owner: "example", repo: "krypto" }, eventName: "workflow_run",
        ref: "refs/heads/main", payload: { repository: { default_branch: "main" }, workflow_run: { id: 310 } } },
    })).toEqual({ allowed: false, reason: "source-command-not-activated" });
  });

  it("retains authorized model-outage observation after a successful membership gate", async () => {
    const request = jest.fn(async (route: string) => ({
      data: route.endsWith("/jobs") ? { jobs: [
        { name: "activation", status: "completed", conclusion: "success" },
        { name: "agent", status: "completed", conclusion: "failure" },
      ] } : {
        repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
        head_branch: "main", status: "completed", path: ".github/workflows/opportunity-discovery.lock.yml",
        event: "workflow_dispatch", actor: { type: "Bot", login: "github-actions[bot]" }, run_attempt: 1,
      },
    }));
    expect(await watchdog.authorizeWatchdogEvent({
      github: { request }, context: { repo: { owner: "example", repo: "krypto" }, eventName: "workflow_run",
        ref: "refs/heads/main", payload: { repository: { default_branch: "main" }, workflow_run: { id: 310 } } },
    })).toEqual({ allowed: true, reason: "trusted-command-activation" });
  });

  it.each(["daily-repo-status", "agentic-governance", "harness-entropy", "agentic-corrections"])(
    "%s is optional, collects before the model and cannot create report issues",
    (name) => {
      const source = fs.readFileSync(path.join(root, `.github/workflows/${name}.md`), "utf8");
      const frontmatter = parseYaml(source.split(/^---\s*$/m)[1]);
      expect(frontmatter.on.schedule).toBeUndefined();
      expect(source).toContain("runCollectionStep({ github, context, core,");
      expect(frontmatter["safe-outputs"].jobs["record-summary"].permissions).toEqual({ contents: "read" });
      expect(frontmatter["safe-outputs"].jobs["record-summary"].if).toContain("needs.agent.result == 'success'");
      const lock = fs.readFileSync(path.join(root, `.github/workflows/${name}.lock.yml`), "utf8");
      expect(lock.includes('"create_issue":')).toBe(false);
    },
  );

  it.each(["opportunity-discovery", "ci-doctor"])("%s submits only through a successful typed safe job", (name) => {
    const source = fs.readFileSync(path.join(root, `.github/workflows/${name}.md`), "utf8");
    const frontmatter = parseYaml(source.split(/^---\s*$/m)[1]);
    expect(frontmatter.concurrency.group).toBe("factory-queue-controller");
    expect(frontmatter["safe-outputs"].jobs["submit-signal"].if).toContain("needs.agent.result == 'success'");
    expect(frontmatter["safe-outputs"]["create-issue"]).toBeUndefined();
  });
});
