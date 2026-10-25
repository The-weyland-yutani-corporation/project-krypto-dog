import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { archiveText } from "./receipt-archive-fixture";
import { creditFixture, CREDIT_CACHE_FILE, CREDIT_NOW } from "./credit-admission-fixture";

interface Decision {
  allowed: boolean;
  reason: string;
  total?: number;
  limit?: number;
  retryAfter: string | null;
}

const credit = jest.requireActual<{
  WINDOW_MS: number;
  readWorkflowCreditLimits(workflow: string): { perRun: number; perDay: number };
  readCreditCache(text: string, runs: object[]): Array<{ id: number; createdAt: string; credits: number }>;
  budgetDecision(usage: Array<{ id: number; createdAt: string; credits: number }>, limits: { perDay: number }): Decision;
  createCreditAdmission(input: ReturnType<typeof creditFixture>["input"]): (workflow: string) => Promise<Decision>;
}>("../../.github/scripts/agentic-credit-admission.cjs");
const receipts = jest.requireActual<{
  readSingleFileArchive(data: Buffer, filename: string, maxSize?: number): string;
  readReceiptArchive(data: Buffer): unknown;
}>("../../.github/scripts/agentic-receipt.cjs");

function admit(fixture: ReturnType<typeof creditFixture>) {
  return credit.createCreditAdmission(fixture.input)(fixture.workflow);
}

describe("trusted workflow credit limits", () => {
  it("reads the distinct source limits without changing them", () => {
    expect(credit.readWorkflowCreditLimits("code-review.lock.yml")).toEqual({ perRun: 1500, perDay: 5000 });
    expect(credit.readWorkflowCreditLimits("trading-safety-review.lock.yml")).toEqual({ perRun: 1600, perDay: 4000 });
    expect(credit.readWorkflowCreditLimits("implement-ticket.lock.yml")).toEqual({ perRun: 500, perDay: 1500 });
  });

  it("can read all committed agentic workflow policies", () => {
    const workflows = fs.readdirSync(path.join(__dirname, "../../.github/workflows"))
      .filter((name) => name.endsWith(".lock.yml"));
    expect(workflows).toHaveLength(18);
    for (const workflow of workflows) {
      const limits = credit.readWorkflowCreditLimits(workflow);
      expect(limits.perDay).toBeGreaterThanOrEqual(limits.perRun);
    }
  });

  it.each(["../code-review.lock.yml", "code-review.md", "ci.yml", "code-review.lock.yml/extra"])(
    "rejects a noncanonical policy path: %s", (workflow) => {
      expect(() => credit.readWorkflowCreditLimits(workflow)).toThrow("exact agentic workflow");
    },
  );

  it.each([
    "max-daily-ai-credits: 0",
    "max-daily-ai-credits: -1",
    "max-daily-ai-credits: 1k",
    "max-daily-ai-credits: 9007199254740992",
    "max-daily-ai-credits: 5000\nmax-daily-ai-credits: 10000",
  ])("fails closed on invalid or ambiguous literal limits: %s", (daily) => {
    const read = jest.spyOn(fs, "readFileSync").mockReturnValue(`---\nmax-ai-credits: 1500\n${daily}\n---\n`);
    try {
      expect(() => credit.readWorkflowCreditLimits("code-review.lock.yml")).toThrow("max-daily-ai-credits");
    } finally {
      read.mockRestore();
    }
  });

  it("requires frontmatter rather than accepting a budget mentioned in the prompt", () => {
    const read = jest.spyOn(fs, "readFileSync").mockReturnValue("max-daily-ai-credits: 5000");
    try {
      expect(() => credit.readWorkflowCreditLimits("code-review.lock.yml")).toThrow("frontmatter");
    } finally {
      read.mockRestore();
    }
  });
});

describe("bounded native credit ledger", () => {
  it("reads the native JSONL file without weakening receipt.json validation", () => {
    const text = '{"run_id":1,"aic":3.5,"timestamp":"2026-10-25T14:01:00Z"}\n';
    const zip = archiveText(text, CREDIT_CACHE_FILE);
    expect(receipts.readSingleFileArchive(zip, CREDIT_CACHE_FILE)).toBe(text);
    expect(() => receipts.readReceiptArchive(zip)).toThrow("entry");
  });

  it("retains the original receipt size limit while allowing a bounded credit ledger", () => {
    const text = "x".repeat(65537);
    expect(() => receipts.readReceiptArchive(archiveText(text))).toThrow("entry");
    expect(receipts.readSingleFileArchive(archiveText(text, CREDIT_CACHE_FILE), CREDIT_CACHE_FILE, 524288)).toBe(text);
    expect(() => receipts.readSingleFileArchive(archiveText("x", CREDIT_CACHE_FILE), CREDIT_CACHE_FILE, 524289))
      .toThrow("constraints");
  });

  it.each(["../agentic-workflow-usage-cache.jsonl", "wrong.jsonl"])("rejects an unexpected archive path: %s", (filename) => {
    expect(() => receipts.readSingleFileArchive(archiveText("{}", filename), CREDIT_CACHE_FILE)).toThrow("entry");
  });

  it("rejects an oversized declared ledger and mismatched payload length", () => {
    const zip = archiveText("{}", CREDIT_CACHE_FILE);
    const end = zip.length - 22;
    const directory = zip.readUInt32LE(end + 16);
    zip.writeUInt32LE(524289, directory + 24);
    expect(() => receipts.readSingleFileArchive(zip, CREDIT_CACHE_FILE, 524288)).toThrow("entry");
    zip.writeUInt32LE(3, directory + 24);
    expect(() => receipts.readSingleFileArchive(zip, CREDIT_CACHE_FILE, 524288)).toThrow("length mismatch");
  });

  it("bounds actual decompression rather than trusting a small declared size", () => {
    const zip = archiveText("{}", CREDIT_CACHE_FILE);
    const name = Buffer.from(CREDIT_CACHE_FILE);
    const directory = zip.readUInt32LE(zip.length - 22 + 16);
    const payload = deflateRawSync(Buffer.from("x".repeat(524289)));
    const local = Buffer.from(zip.subarray(0, 30));
    const central = Buffer.from(zip.subarray(directory, directory + 46));
    local.writeUInt16LE(8, 8);
    central.writeUInt16LE(8, 10);
    local.writeUInt32LE(payload.length, 18);
    central.writeUInt32LE(payload.length, 20);
    const end = Buffer.from(zip.subarray(zip.length - 22));
    end.writeUInt32LE(local.length + name.length + payload.length, 16);
    const bomb = Buffer.concat([local, name, payload, central, name, end]);
    expect(() => receipts.readSingleFileArchive(bomb, CREDIT_CACHE_FILE, 524288)).toThrow();
  });

  it.each([
    { aic: -1 }, { aic: "12" }, { aic: null }, { aic: Number.MAX_VALUE },
    { timestamp: "invalid" }, { timestamp: "2026-10-24T00:00:00Z" },
    { timestamp: "2026-10-26T00:00:00Z" }, { run_id: 999 },
    { extra: "untrusted" },
  ])("rejects malformed or unbound ledger data: %j", (change) => {
    const fixture = creditFixture();
    fixture.addRun(12);
    const text = JSON.stringify({ ...fixture.entries[0], ...change });
    expect(() => credit.readCreditCache(text, fixture.runs)).toThrow();
  });

  it("rejects duplicates and missing current-attempt usage", () => {
    const fixture = creditFixture();
    fixture.addRun(12);
    const row = JSON.stringify(fixture.entries[0]);
    expect(() => credit.readCreditCache(`${row}\n${row}`, fixture.runs)).toThrow("duplicate");
    expect(() => credit.readCreditCache("", fixture.runs)).toThrow("complete");
    fixture.runs[0].run_attempt = 2;
    expect(() => credit.readCreditCache(row, fixture.runs)).toThrow("current-attempt");
  });
});

describe("controller credit admission", () => {
  it("admits empty native history without inventing a usage artifact", async () => {
    const fixture = creditFixture();
    expect(await admit(fixture)).toEqual({
      allowed: true, reason: "within-recorded-budget", total: 0, limit: 5000, retryAfter: null,
    });
    expect(fixture.api.downloadArtifact).not.toHaveBeenCalled();
    expect(fixture.api.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({
      created: ">=2026-10-24T15:00:00.000Z",
    }));
  });

  it("accepts exact-threshold usage using the pinned native admission semantics", async () => {
    const fixture = creditFixture();
    fixture.addRun(5000);
    expect(await admit(fixture)).toMatchObject({ allowed: true, total: 5000 });
  });

  it("defers over-budget work with the exact creation-time expiry, not midnight", async () => {
    const fixture = creditFixture();
    fixture.addRun(2000, { created_at: "2026-10-25T04:59:25Z", updated_at: "2026-10-25T05:15:57Z" });
    fixture.addRun(4500);
    expect(await admit(fixture)).toEqual({
      allowed: false, reason: "rolling-credit-limit", total: 6500, limit: 5000,
      retryAfter: "2026-10-26T04:59:25.001Z",
    });
    expect(fixture.core.info).toHaveBeenCalledWith(expect.stringContaining("No dispatch was admitted"));
  });

  it("matches the observed code-review total and next natural admission window", () => {
    const usage = [
      ["2026-10-25T02:50:10Z", 353.95733750000005],
      ["2026-10-25T03:53:08Z", 94.10592500000001],
      ["2026-10-25T04:59:25Z", 1515.0713875],
      ["2026-10-25T06:10:15Z", 1501.7251375000003],
      ["2026-10-25T06:47:38Z", 1502.3575],
      ["2026-10-25T08:48:03Z", 31.588162500000003],
      ["2026-10-25T09:35:06Z", 1512.9756250000003],
    ] satisfies Array<[string, number]>;
    const result = credit.budgetDecision(usage.map(([createdAt, credits], id) => ({ id, createdAt, credits })), { perDay: 5000 });
    expect(result.allowed).toBe(false);
    expect(result.total).toBeCloseTo(6511.781075, 6);
    expect(result.retryAfter).toBe("2026-10-26T04:59:25.001Z");
  });

  it("rechecks naturally on a later pass without retrying within the same pass", async () => {
    const fixture = creditFixture();
    fixture.addRun(5001);
    const first = credit.createCreditAdmission(fixture.input);
    expect((await first(fixture.workflow)).allowed).toBe(false);
    const reads = fixture.api.listWorkflowRuns.mock.calls.length;
    expect((await first(fixture.workflow)).allowed).toBe(false);
    expect(fixture.api.listWorkflowRuns).toHaveBeenCalledTimes(reads);
    const later = credit.createCreditAdmission({
      ...fixture.input, now: new Date(Date.parse(fixture.runs[0].created_at) + credit.WINDOW_MS + 1).toISOString(),
    });
    expect((await later(fixture.workflow)).allowed).toBe(true);
  });

  it("does not admit two unobserved runs of the same workflow in one pass", async () => {
    const fixture = creditFixture();
    const check = credit.createCreditAdmission(fixture.input);
    expect((await check(fixture.workflow)).allowed).toBe(true);
    const reads = fixture.api.listWorkflowRuns.mock.calls.length;
    expect(await check(fixture.workflow)).toMatchObject({ allowed: false, reason: "already-admitted-this-pass" });
    expect(fixture.api.listWorkflowRuns).toHaveBeenCalledTimes(reads);
    expect(fixture.core.info).toHaveBeenCalledWith(expect.stringContaining("already-admitted-this-pass"));
  });

  it.each(["queued", "in_progress", "waiting", "pending", "requested"])(
    "defers %s runs, even when created before the credit window", async (status) => {
      const fixture = creditFixture();
      fixture.addRun(0, { status, created_at: "2026-10-23T00:00:00Z" });
      expect(await admit(fixture)).toMatchObject({ allowed: false, reason: "usage-pending" });
      expect(fixture.api.downloadArtifact).not.toHaveBeenCalled();
    },
  );

  it("does not treat an unfinished recent run as zero usage", async () => {
    const fixture = creditFixture();
    fixture.addRun(0, { status: "in_progress" });
    expect(await admit(fixture)).toMatchObject({ allowed: false, reason: "usage-pending" });
    expect(fixture.api.downloadArtifact).not.toHaveBeenCalled();
  });

  it("detects a new run between the ledger read and final admission", async () => {
    const fixture = creditFixture();
    fixture.addRun(10);
    const original = fixture.api.listWorkflowRuns.getMockImplementation()!;
    fixture.api.listWorkflowRuns.mockImplementation(async (params) => {
      if (params.per_page === 1 && !params.status) fixture.addRun(0, { status: "queued" });
      return original(params);
    });
    expect(await admit(fixture)).toMatchObject({ allowed: false, reason: "usage-pending" });
  });

  it("detects an old run starting after the outstanding-run reads", async () => {
    const fixture = creditFixture();
    fixture.addRun(0, { created_at: "2026-10-23T00:00:00Z" });
    const original = fixture.api.listWorkflowRuns.getMockImplementation()!;
    fixture.api.listWorkflowRuns.mockImplementation(async (params) => {
      const response = await original(params);
      if (params.per_page === 1 && !params.status) {
        response.data.workflow_runs = response.data.workflow_runs.map((run) => ({ ...run, status: "queued" }));
      }
      return response;
    });
    expect(await admit(fixture)).toMatchObject({ allowed: false, reason: "usage-pending" });
  });

  it("rejects a final latest run that regresses outside the observed window", async () => {
    const fixture = creditFixture();
    fixture.addRun(10);
    const original = fixture.api.listWorkflowRuns.getMockImplementation()!;
    fixture.api.listWorkflowRuns.mockImplementation(async (params) => {
      const response = await original(params);
      if (params.per_page === 1 && !params.status) {
        response.data.workflow_runs = response.data.workflow_runs.map((run) => ({
          ...run, id: run.id - 1, created_at: "2026-10-23T00:00:00Z",
        }));
      }
      return response;
    });
    expect(await admit(fixture)).toMatchObject({ allowed: false, reason: "credit-history-changed" });
  });

  it("detects changed attempts or completion metadata before dispatch", async () => {
    const fixture = creditFixture();
    fixture.addRun(10);
    const original = fixture.api.listWorkflowRuns.getMockImplementation()!;
    fixture.api.listWorkflowRuns.mockImplementation(async (params) => {
      const response = await original(params);
      if (params.per_page === 1 && !params.status) {
        response.data.workflow_runs = response.data.workflow_runs.map((run) => ({ ...run, run_attempt: 2 }));
      }
      return response;
    });
    expect(await admit(fixture)).toMatchObject({ allowed: false, reason: "credit-history-changed" });
  });

  it.each([
    { expired: true }, { size_in_bytes: 262145 }, { id: 0 }, { workflow_run: { id: 9999 } },
  ])("rejects invalid latest-cache provenance: %j", async (change) => {
    const fixture = creditFixture();
    fixture.addRun(10);
    Object.assign(fixture.artifact, change);
    await expect(admit(fixture)).rejects.toThrow("cache artifact");
    expect(fixture.api.downloadArtifact).not.toHaveBeenCalled();
  });

  it("refuses missing or ambiguous artifacts rather than looking for an older success", async () => {
    const fixture = creditFixture();
    fixture.addRun(10);
    fixture.api.listWorkflowRunArtifacts.mockResolvedValue({ data: { total_count: 0, artifacts: [] } });
    await expect(admit(fixture)).rejects.toThrow("unique latest-run");
    fixture.api.listWorkflowRunArtifacts.mockResolvedValue({
      data: { total_count: 2, artifacts: [fixture.artifact, { ...fixture.artifact, id: 902 }] },
    });
    await expect(admit(fixture)).rejects.toThrow("unique latest-run");
    expect(fixture.api.downloadArtifact).not.toHaveBeenCalled();
  });

  it("reports artifact transport failures without exposing signed URLs", async () => {
    const fixture = creditFixture();
    fixture.addRun(10);
    fixture.api.downloadArtifact.mockRejectedValue(new Error("https://example.invalid/private?sig=secret"));
    await expect(admit(fixture)).rejects.toThrow(/^Native credit cache download failed; no dispatch is admitted\.$/);
  });

  it("does not retry an uncertain API read within the controller pass", async () => {
    const fixture = creditFixture();
    fixture.api.listWorkflowRuns.mockRejectedValue(new Error("native API unavailable"));
    const check = credit.createCreditAdmission(fixture.input);
    await expect(check(fixture.workflow)).rejects.toThrow("native API unavailable");
    expect(await check(fixture.workflow)).toMatchObject({ allowed: false, reason: "credit-admission-unresolved" });
    expect(fixture.api.listWorkflowRuns).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: 0 }, { workflow_id: 0 }, { run_attempt: 0 }, { path: ".github/workflows/other.lock.yml" },
    { repository: { full_name: "foreign/repo" } }, { status: "unknown" },
    { created_at: "invalid" }, { updated_at: "2026-10-24T00:00:00Z" },
  ])("rejects invalid or foreign run metadata: %j", async (change) => {
    const fixture = creditFixture();
    fixture.addRun(10);
    Object.assign(fixture.runs[0], change);
    // Deliver invalid timestamps as API data rather than filtering them out in the fixture.
    if (change.created_at === "invalid") {
      fixture.api.listWorkflowRuns.mockResolvedValue({ data: { total_count: 1, workflow_runs: fixture.runs } });
    }
    await expect(admit(fixture)).rejects.toThrow();
    expect(fixture.api.downloadArtifact).not.toHaveBeenCalled();
  });

  it("paginates the whole bounded window instead of counting just the first page", async () => {
    const fixture = creditFixture();
    for (let index = 0; index < 101; index += 1) fixture.addRun(50);
    expect(await admit(fixture)).toMatchObject({ allowed: false, total: 5050 });
    expect(fixture.api.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
  });

  it("rejects oversized, truncated or changing native history", async () => {
    const fixture = creditFixture();
    fixture.addRun(10);
    fixture.api.listWorkflowRuns.mockResolvedValue({ data: { total_count: 1001, workflow_runs: fixture.runs } });
    await expect(admit(fixture)).rejects.toThrow("bound");
    fixture.api.listWorkflowRuns.mockResolvedValue({ data: { total_count: 2, workflow_runs: fixture.runs } });
    await expect(admit(fixture)).rejects.toThrow("pagination");
    fixture.api.listWorkflowRuns.mockResolvedValue({ data: { total_count: 0, workflow_runs: fixture.runs } });
    await expect(admit(fixture)).rejects.toThrow("incomplete");
  });

  it("rejects invalid controller clocks", () => {
    const fixture = creditFixture();
    expect(() => credit.createCreditAdmission({ ...fixture.input, now: "invalid" })).toThrow("timestamps");
    expect(new Date(CREDIT_NOW).toISOString()).toBe(CREDIT_NOW);
  });

  it("requires one native workflow identity across the full usage window", async () => {
    const fixture = creditFixture();
    fixture.addRun(10);
    fixture.addRun(10, { workflow_id: 99 });
    await expect(admit(fixture)).rejects.toThrow("mixes workflow identities");
    expect(fixture.api.downloadArtifact).not.toHaveBeenCalled();
  });

  it("places the credit gate before the autonomous dispatch receipt", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../.github/scripts/agentic-pr-reconciler.cjs"), "utf8");
    const dispatch = source.slice(source.indexOf("const dispatchForPullRequest ="));
    expect(dispatch).toContain("await admitCredits(workflowId)");
    expect(dispatch).toContain("await onDispatch(record)");
    expect(dispatch.indexOf("await admitCredits(workflowId)")).toBeLessThan(dispatch.indexOf("createDispatchRecord("));
    expect(dispatch.indexOf("await onDispatch(record)")).toBeLessThan(dispatch.indexOf("await dispatch(workflowId"));
  });
});
