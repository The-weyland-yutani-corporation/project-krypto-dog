import { archiveText } from "./receipt-archive-fixture";

export const CREDIT_NOW = "2026-10-25T15:00:00.000Z";
export const CREDIT_CACHE_FILE = "agentic-workflow-usage-cache.jsonl";

export interface CreditRun {
  id: number;
  workflow_id: number;
  run_attempt: number;
  path: string;
  repository: { full_name: string };
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreditEntry {
  run_id: number;
  aic: number;
  timestamp: string;
}

export interface CreditParams {
  owner?: string;
  repo?: string;
  workflow_id?: string;
  status?: string;
  created?: string;
  per_page?: number;
  page?: number;
  run_id?: number;
  artifact_id?: number;
  archive_format?: string;
}

export function creditFixture(
  workflow = "code-review.lock.yml",
  repository = "o/r",
  now = CREDIT_NOW,
) {
  const runs: CreditRun[] = [];
  const entries: CreditEntry[] = [];
  const artifact = {
    id: 901, name: "aic-usage-cache", expired: false, size_in_bytes: 512,
    workflow_run: { id: 0 },
  };
  const core = { info: jest.fn() };
  const api = {
    listWorkflowRuns: jest.fn(async (input: CreditParams) => {
      let matching = input.workflow_id === workflow ? [...runs] : [];
      if (input.created) {
        const cutoff = Date.parse(input.created.slice(2));
        matching = matching.filter((run) => Date.parse(run.created_at) >= cutoff);
      }
      if (input.status) matching = matching.filter((run) => run.status === input.status);
      matching.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      const pageSize = input.per_page ?? 100;
      const start = ((input.page ?? 1) - 1) * pageSize;
      return { data: { total_count: matching.length, workflow_runs: matching.slice(start, start + pageSize) } };
    }),
    listWorkflowRunArtifacts: jest.fn(async (_input: CreditParams) => ({
      data: { total_count: 1, artifacts: [artifact] },
    })),
    downloadArtifact: jest.fn(async (_input: CreditParams) => ({
      data: archiveText(entries.map((entry) => JSON.stringify(entry)).join("\n"), CREDIT_CACHE_FILE),
    })),
  };
  const [owner, repo] = repository.split("/");
  return {
    workflow, now, runs, entries, artifact, core, api,
    input: { github: { rest: { actions: api } }, owner, repo, core, now },
    addRun(credits: number, overrides: Partial<CreditRun> = {}) {
      const created = new Date(Date.parse(now) - 3600000 + runs.length * 1000).toISOString();
      const run: CreditRun = {
        id: 100 + runs.length, workflow_id: 9, run_attempt: 1,
        path: `.github/workflows/${workflow}`, repository: { full_name: repository },
        status: "completed", created_at: created,
        updated_at: new Date(Date.parse(created) + 60000).toISOString(),
        ...overrides,
      };
      runs.push(run);
      entries.push({ run_id: run.id, aic: credits, timestamp: run.updated_at });
      artifact.workflow_run.id = [...runs].sort((left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at))[0].id;
      return run;
    },
  };
}
