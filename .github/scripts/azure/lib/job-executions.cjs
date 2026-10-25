const assert = require("node:assert/strict");

const apiVersion = "2023-05-01";
const maxPages = 20;
const maxExecutions = 2000;
const jobIdPattern = /^\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourceGroups\/[A-Za-z0-9_.()-]{1,90}\/providers\/Microsoft\.App\/jobs\/[a-z][a-z0-9-]{0,31}$/i;

/** @typedef {{id: string, name: string, properties: {status: string, startTime?: string, endTime?: string}}} JobExecution */

/**
 * @param {string} jobResourceId
 * @param {(args: string[]) => Promise<unknown>} read
 * @param {number} [startedAt]
 * @returns {Promise<JobExecution[]>}
 */
async function readJobExecutions(jobResourceId, read, startedAt = Date.now()) {
  assert(typeof jobResourceId === "string", "An exact Azure job resource ID is required.");
  const identity = jobIdPattern.exec(jobResourceId);
  assert(identity, "An exact Azure job resource ID is required.");
  const base = new URL(`https://management.azure.com${jobResourceId}/executions?api-version=${apiVersion}`);
  assert(base.pathname === `${jobResourceId}/executions`, "An exact Azure job resource ID is required.");
  const seenPages = new Set();
  const seenExecutions = new Set();
  const executions = [];
  let nextLink = base.href;

  while (nextLink !== undefined) {
    assert(Number.isFinite(startedAt) && Date.now() >= startedAt && Date.now() - startedAt <= 90_000,
      "Azure execution pagination exceeded 90 seconds.");
    const pageUrl = new URL(nextLink);
    assert(pageUrl.origin === base.origin && !pageUrl.username && !pageUrl.password && !pageUrl.hash &&
      pageUrl.pathname.toLowerCase() === base.pathname.toLowerCase() &&
      pageUrl.searchParams.getAll("api-version").length === 1 &&
      pageUrl.searchParams.get("api-version") === apiVersion,
    "Azure execution continuation must retain the exact resource, API version and HTTPS authority.");
    assert(seenPages.size < maxPages && !seenPages.has(pageUrl.href),
      "Azure execution pagination is cyclic or exceeds 20 pages.");
    seenPages.add(pageUrl.href);
    const page = await read([
      "rest", "--method", "get", "--url", pageUrl.href,
      "--subscription", identity[1], "--output", "json",
    ]);
    assert(page && typeof page === "object" && Array.isArray(page.value) && !Object.hasOwn(page, "error"),
      "Azure execution inventory must contain a page of values.");
    assert(executions.length + page.value.length <= maxExecutions,
      "Azure execution inventory exceeds 2000 records.");
    for (const execution of page.value) {
      assert(execution && typeof execution.id === "string" &&
        typeof execution.name === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(execution.name) &&
        execution.id.toLowerCase() === `${jobResourceId}/executions/${execution.name}`.toLowerCase() &&
        typeof execution.properties?.status === "string",
      "Azure returned an execution outside the expected job or without its identity/status.");
      assert(!seenExecutions.has(execution.id.toLowerCase()), "Azure execution inventory contains duplicate records.");
      seenExecutions.add(execution.id.toLowerCase());
      for (const field of ["startTime", "endTime"]) {
        assert(execution.properties[field] == null || typeof execution.properties[field] === "string",
          "Azure execution timing metadata must be a timestamp or absent.");
      }
      executions.push({
        id: execution.id, name: execution.name, properties: {
          status: execution.properties.status,
          ...(execution.properties.startTime == null ? {} : { startTime: execution.properties.startTime }),
          ...(execution.properties.endTime == null ? {} : { endTime: execution.properties.endTime }),
        },
      });
    }
    assert(page.nextLink == null || typeof page.nextLink === "string",
      "Azure returned an invalid execution continuation.");
    nextLink = page.nextLink == null || page.nextLink === "" ? undefined : page.nextLink;
  }
  assert(Date.now() >= startedAt && Date.now() - startedAt <= 90_000,
    "Azure execution pagination exceeded 90 seconds.");
  return executions;
}

module.exports = { readJobExecutions };

if (require.main === module) {
  (async () => {
    assert(process.argv.length === 3, "Expected one Azure job readback file.");
    const { readFileSync } = require("node:fs");
    const { execFile } = require("node:child_process");
    const { promisify } = require("node:util");
    const execute = promisify(execFile);
    const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const executions = await readJobExecutions(job.id, async (args) => {
      const { stdout } = await execute("az", args, {
        encoding: "utf8", timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    });
    process.stdout.write(`${JSON.stringify(executions)}\n`);
  })().catch((error) => {
    process.stderr.write(`Azure execution inventory failed (${error instanceof Error ? error.name : "UnknownError"}).\n`);
    process.exitCode = 1;
  });
}
