import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJobExecutions } from "../../../.github/scripts/azure/lib/job-executions.cjs";

const subscription = "00000000-0000-0000-0000-000000000001";
const jobId = `/subscriptions/${subscription}/resourceGroups/rg-prod/providers/Microsoft.App/jobs/caj-hourly`;
const baseUrl = `https://management.azure.com${jobId}/executions?api-version=2023-05-01`;
const pageUrl = (index: number) => index === 0 ? baseUrl : `${baseUrl}&$skiptoken=${index}`;
const execution = (index: number) => ({
  id: `${jobId}/executions/hourly-${index}`, name: `hourly-${index}`, properties: { status: "Succeeded" },
});
const reader = (pages: Map<string, unknown>) => jest.fn(async (args: string[]): Promise<unknown> => {
  expect(args.slice(0, 4)).toEqual(["rest", "--method", "get", "--url"]);
  expect(args.slice(5)).toEqual(["--subscription", subscription, "--output", "json"]);
  if (!pages.has(args[4])) throw new Error("Unexpected Azure page.");
  return pages.get(args[4]);
});

describe("bounded ARM job execution inventory", () => {
  it("reads every page, retaining active records instead of treating a terminal first page as exhaustive", async () => {
    const active = { ...execution(1), properties: { status: "Running" } };
    const read = reader(new Map([
      [baseUrl, { value: [execution(0)], nextLink: pageUrl(1) }],
      [pageUrl(1), { value: [active] }],
    ]));
    expect(await readJobExecutions(jobId, read)).toEqual([execution(0), active]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, ""])("accepts the terminal nextLink representation %s", async (nextLink) => {
    const read = reader(new Map([[baseUrl, { value: [], nextLink }]]));
    expect(await readJobExecutions(jobId, read)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    baseUrl.replace("https:", "http:"),
    baseUrl.replace("management.azure.com", "elsewhere.example"),
    baseUrl.replace("management.azure.com", "user:password@management.azure.com"),
    baseUrl.replace("management.azure.com", "management.azure.com:444"),
    baseUrl.replace("/caj-hourly/", "/caj-daily/"),
    baseUrl.replace(subscription, "11111111-1111-1111-1111-111111111111"),
    baseUrl.replace("2023-05-01", "2025-01-01"),
    `${baseUrl}&api-version=2023-05-01`,
    `${baseUrl}#fragment`,
    "?$skiptoken=relative",
    "not-a-url",
  ])("rejects unsafe continuation %s before another Azure request", async (nextLink) => {
    const read = reader(new Map([[baseUrl, { value: [], nextLink }]]));
    await expect(readJobExecutions(jobId, read)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects continuation cycles without rereading a page", async () => {
    const read = reader(new Map([[baseUrl, { value: [], nextLink: baseUrl }]]));
    await expect(readJobExecutions(jobId, read)).rejects.toThrow(/cyclic/);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([20, 21])("enforces the 20-page boundary for %i pages", async (count) => {
    const pages = new Map<string, unknown>();
    for (let index = 0; index < count; index++) {
      pages.set(pageUrl(index), {
        value: [execution(index)], nextLink: index + 1 < count ? pageUrl(index + 1) : undefined,
      });
    }
    const read = reader(pages);
    if (count === 20) {
      expect(await readJobExecutions(jobId, read)).toHaveLength(20);
    } else {
      await expect(readJobExecutions(jobId, read)).rejects.toThrow(/exceeds 20 pages/);
    }
    expect(read).toHaveBeenCalledTimes(20);
  });

  it.each([2000, 2001])("enforces the aggregate 2,000-record boundary for %i records", async (count) => {
    const values = Array.from({ length: count }, (_value, index) => execution(index));
    const read = reader(new Map([
      [baseUrl, { value: values.slice(0, 1000), nextLink: pageUrl(1) }],
      [pageUrl(1), { value: values.slice(1000) }],
    ]));
    if (count === 2000) {
      expect(await readJobExecutions(jobId, read)).toHaveLength(2000);
    } else {
      await expect(readJobExecutions(jobId, read)).rejects.toThrow(/exceeds 2000 records/);
    }
  });

  it.each([
    null, [], {}, { value: "[]" }, { value: [], nextLink: 1 }, { value: [], error: { code: "Failed" } },
    { value: [null] }, { value: [{ properties: { status: "Succeeded" } }] },
    { value: [{ ...execution(0), id: `${jobId}-foreign/executions/hourly-0` }] },
    { value: [{ ...execution(0), name: "../outside" }] },
    { value: [{ ...execution(0), properties: {} }] },
  ])("rejects malformed or unbound inventory %#", async (page) => {
    const read = reader(new Map([[baseUrl, page]]));
    await expect(readJobExecutions(jobId, read)).rejects.toThrow();
  });

  it("rejects duplicate identities across pages", async () => {
    const read = reader(new Map([
      [baseUrl, { value: [execution(0)], nextLink: pageUrl(1) }],
      [pageUrl(1), { value: [execution(0)] }],
    ]));
    await expect(readJobExecutions(jobId, read)).rejects.toThrow(/duplicate records/);
  });

  it("does not return a partial inventory after a later request fails", async () => {
    const read = reader(new Map([[baseUrl, { value: [execution(0)], nextLink: pageUrl(1) }]]));
    await expect(readJobExecutions(jobId, read)).rejects.toThrow(/Unexpected Azure page/);
  });

  it.each([90_000, 90_001, -1])("enforces the inclusive 90-second interval for %i ms", async (elapsed) => {
    jest.useFakeTimers();
    const start = new Date("2026-10-21T12:00:00Z").getTime();
    jest.setSystemTime(start);
    try {
      const read = jest.fn(async () => {
        jest.setSystemTime(start + elapsed);
        return { value: [] };
      });
      if (elapsed === 90_000) {
        expect(await readJobExecutions(jobId, read, start)).toEqual([]);
      } else {
        await expect(readJobExecutions(jobId, read, start)).rejects.toThrow(/exceeded 90 seconds/);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    "", "https://management.azure.com", `${jobId}/executions/not-a-job`,
    jobId.replace("rg-prod", "."), jobId.replace("rg-prod", ".."),
  ])(
    "rejects invalid job identity %s before Azure access", async (id) => {
      const read = jest.fn(async () => ({ value: [] }));
      await expect(readJobExecutions(id, read)).rejects.toThrow(/exact Azure job resource ID/);
      expect(read).not.toHaveBeenCalled();
    },
  );
});

describe("native execution-inventory transport", () => {
  it.each([false, true])("runs the actual CLI with safe failure=%s and no provider body disclosure", (fail) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "krypto-execution-pages-"));
    try {
      const jobFile = path.join(directory, "job.json");
      const pagesFile = path.join(directory, "pages.json");
      const preload = path.join(directory, "azure-fixture.cjs");
      const callFile = path.join(directory, "calls.jsonl");
      fs.writeFileSync(jobFile, JSON.stringify({ id: jobId }));
      fs.writeFileSync(pagesFile, JSON.stringify({
        [baseUrl]: { value: [execution(0)], nextLink: pageUrl(1) },
        [pageUrl(1)]: fail ? null : { value: [execution(1)] },
      }));
      fs.writeFileSync(preload, `
        const fs = require("node:fs");
        const assert = require("node:assert/strict");
        const child = require("node:child_process");
        const execute = () => { throw new Error("Unexpected callback path"); };
        execute[require("node:util").promisify.custom] = async (file, args) => {
          assert.equal(file, "az");
          fs.appendFileSync(process.env.AZURE_FIXTURE_CALLS, JSON.stringify(args) + "\\n");
          const pages = JSON.parse(fs.readFileSync(process.env.AZURE_FIXTURE_PAGES, "utf8"));
          const page = pages[args[args.indexOf("--url") + 1]];
          if (!page) throw new Error("PRIVATE_PROVIDER_BODY");
          return { stdout: JSON.stringify(page), stderr: "" };
        };
        child.execFile = execute;
      `);
      const result = spawnSync(process.execPath, [
        "--require", preload,
        path.resolve(__dirname, "../../../.github/scripts/azure/lib/job-executions.cjs"), jobFile,
      ], {
        encoding: "utf8",
        env: { ...process.env, AZURE_FIXTURE_PAGES: pagesFile, AZURE_FIXTURE_CALLS: callFile },
      });
      expect(result.status).toBe(fail ? 1 : 0);
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_PROVIDER_BODY");
      if (fail) {
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Azure execution inventory failed (Error)");
      } else {
        expect(JSON.parse(result.stdout)).toEqual([execution(0), execution(1)]);
      }
      const calls = fs.readFileSync(callFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toEqual([baseUrl, pageUrl(1)].map((url) => [
        "rest", "--method", "get", "--url", url, "--subscription", subscription, "--output", "json",
      ]));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the full-inventory reader for both native quiescence checks", () => {
    const script = fs.readFileSync(path.resolve(__dirname, "../../../.github/scripts/azure/verify-disabled-rollout.sh"), "utf8");
    expect(script).toContain('node "${script_dir}/lib/job-executions.cjs" "${scratch}/hourly.json"');
    expect(script).toContain('node "${script_dir}/lib/job-executions.cjs" "${scratch}/daily.json"');
    expect(script).not.toContain("az containerapp job execution list");
  });
});
