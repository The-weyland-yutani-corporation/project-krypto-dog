import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPaperCommitBeforeDeadline } from "@/trading/paper-executor";
import { ExecutionDeadlineError } from "@/lib/execution-envelope";
import { normalizeAgentRunError } from "@/agent/run-flow";

describe("paper commit deadline fence", () => {
  it("rejects application commits at and after the persisted deadline", () => {
    const deadline = new Date("2026-08-17T00:03:00.000Z");
    expect(() =>
      assertPaperCommitBeforeDeadline(deadline, deadline),
    ).toThrow(ExecutionDeadlineError);
    expect(() =>
      assertPaperCommitBeforeDeadline(
        new Date(deadline.getTime() + 1),
        deadline,
      ),
    ).toThrow(ExecutionDeadlineError);
  });

  it("uses a deferred PostgreSQL commit-time clock fence", () => {
    const migration = readFileSync(
      join(process.cwd(), "drizzle/0009_bounded_execution.sql"),
      "utf8",
    );
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("clock_timestamp() >= run_deadline");
    expect(migration).toContain(
      `"deadlineAt" = "startedAt" + interval '180 seconds'`,
    );
    expect(migration).toContain('"deadlineAt"');
    expect(migration).toContain(
      "krypto_runtime must remain unable to read the drizzle migration ledger",
    );
  });

  it("normalizes the database commit fence as a deadline failure", () => {
    const deadlineAt = new Date("2026-08-17T00:03:00.000Z");
    expect(
      normalizeAgentRunError(
        {
          code: "57014",
          message:
            "Paper trade commit rejected at or after AgentRun deadline",
        },
        deadlineAt,
      ),
    ).toEqual(
      expect.objectContaining({
        code: "execution-deadline-exhausted",
        deadlineAt,
        phase: "paper execution commit",
      }),
    );
  });
});
