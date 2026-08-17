export {};

interface PullRequest {
  number: number;
  title: string;
  draft: boolean;
  html_url: string;
  user: {
    login: string;
    type: string;
  };
  labels: Array<{ name: string }>;
  head: {
    sha: string;
    ref: string;
    repo: {
      full_name: string;
    } | null;
  };
}

interface ChangedFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

interface Review {
  state: string;
  commit_id: string;
  author_association: string;
  user: {
    login: string;
    type: string;
  };
}

interface Commit {
  author: { login: string } | null;
  commit: { message: string };
}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

interface PolicyResult {
  state: string;
  description: string;
  sameRepository: boolean;
  trustedAgent: boolean;
  lowRisk: boolean;
  hasBlockingLabel: boolean;
  hasCurrentHumanApproval: boolean;
  hasCurrentHumanChangesRequested: boolean;
}

interface SelfHealEligibility {
  sameRepository: boolean;
  draft: boolean;
  trustedAgent: boolean;
  lowRisk: boolean;
  hasBlockingLabel: boolean;
  ciNeedsDispatch: boolean;
  reviewShouldDispatch: boolean;
  ciHeld: boolean;
  reviewHeld: boolean;
}

interface ReconcilerModule {
  canAttemptSelfHeal(input: SelfHealEligibility): boolean;
  countRepairAttempts(commits: Commit[]): number;
  evaluateMergePolicy(input: {
    pullRequest: PullRequest;
    files: ChangedFile[];
    reviews: Review[];
    checkRuns?: CheckRun[];
    repository: string;
  }): PolicyResult;
  getAgentApprovalState(
    files: ChangedFile[],
    checkRuns: CheckRun[],
  ): {
    approved: boolean;
    failedCheck?: string;
    waitingCheck?: string;
    requiredSpecialistChecks: string[];
  };
  getRequiredSpecialistChecks(files: ChangedFile[]): string[];
  hasFailedCiRun(
    runs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
    }>,
  ): boolean;
  hasFailedReviewCheck(
    checks: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
    }>,
  ): boolean;
  isLowRiskChange(files: ChangedFile[]): boolean;
  isLowRiskPath(filename: string): boolean;
  isTrustedAgentPullRequest(
    pullRequest: PullRequest,
    repository: string,
  ): boolean;
}

const {
  canAttemptSelfHeal,
  countRepairAttempts,
  evaluateMergePolicy,
  getAgentApprovalState,
  getRequiredSpecialistChecks,
  hasFailedCiRun,
  hasFailedReviewCheck,
  isLowRiskChange,
  isLowRiskPath,
  isTrustedAgentPullRequest,
} = jest.requireActual<ReconcilerModule>(
  "../../.github/scripts/agentic-pr-reconciler.cjs",
);

const repository = "The-weyland-yutani-corporation/project-krypto-dog";

function pullRequest(
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return {
    number: 42,
    title: "[docs-sync] Refresh contributor guide",
    draft: false,
    html_url:
      "https://github.com/The-weyland-yutani-corporation/project-krypto-dog/pull/42",
    user: {
      login: "github-actions[bot]",
      type: "Bot",
    },
    labels: [
      { name: "agentic-factory" },
      { name: "docs-sync" },
      { name: "agentic-automerge" },
    ],
    head: {
      sha: "head-sha",
      ref: "docs/agent-update",
      repo: {
        full_name: repository,
      },
    },
    ...overrides,
  };
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    state: "APPROVED",
    commit_id: "head-sha",
    author_association: "OWNER",
    user: {
      login: "trusted-human",
      type: "User",
    },
    ...overrides,
  };
}

function policy(
  overrides: {
    pullRequest?: PullRequest;
    files?: ChangedFile[];
    reviews?: Review[];
    checkRuns?: CheckRun[];
  } = {},
): PolicyResult {
  return evaluateMergePolicy({
    pullRequest: overrides.pullRequest ?? pullRequest(),
    files: overrides.files ?? [
      {
        filename: "docs/guides/contributing.md",
        status: "modified",
      },
    ],
    reviews: overrides.reviews ?? [],
    checkRuns: overrides.checkRuns ?? [
      {
        id: 1,
        name: "Agentic code review",
        status: "completed",
        conclusion: "success",
      },
    ],
    repository,
  });
}

describe("trusted agent identity", () => {
  it.each(["github-actions[bot]", "copilot-swe-agent[bot]"])(
    "trusts the enrolled same-repository %s identity",
    (login) => {
      expect(
        isTrustedAgentPullRequest(
          pullRequest({
            user: { login, type: "Bot" },
          }),
          repository.toUpperCase(),
        ),
      ).toBe(true);
    },
  );

  it.each([
    {
      name: "human author",
      change: {
        user: { login: "trusted-human", type: "User" },
      },
    },
    {
      name: "unrecognized bot",
      change: {
        user: { login: "dependabot[bot]", type: "Bot" },
      },
    },
    {
      name: "missing enrollment label",
      change: {
        labels: [{ name: "agentic-factory" }],
      },
    },
    {
      name: "unrecognized title",
      change: {
        title: "Refresh contributor guide",
      },
    },
    {
      name: "fork head",
      change: {
        head: {
          sha: "head-sha",
          ref: "docs/agent-update",
          repo: { full_name: "attacker/project-krypto-dog" },
        },
      },
    },
    {
      name: "deleted head repository",
      change: {
        head: {
          sha: "head-sha",
          ref: "docs/agent-update",
          repo: null,
        },
      },
    },
  ])("rejects a $name", ({ change }) => {
    expect(
      isTrustedAgentPullRequest(
        pullRequest(change as Partial<PullRequest>),
        repository,
      ),
    ).toBe(false);
  });
});

describe("low-risk documentation allowlist", () => {
  it.each([
    "docs/guides/contributing.md",
    "docs/e2e/factory-heartbeat.md",
    "docs/images/architecture.PNG",
    "docs/images/example.jpeg",
    "docs/notes/readme.txt",
    "docs/assets/chart.webp",
  ])("allows %s", (filename) => {
    expect(isLowRiskPath(filename)).toBe(true);
  });

  it.each([
    "README.md",
    "src/guide.md",
    "docs/diagram.svg",
    "docs/archive.zip",
    "docs/agentic-guide.md",
    "docs/auth/setup.md",
    "docs/backup-plan.txt",
    "docs/database.notes.md",
    "docs/deployment/run.md",
    "docs/env_reference.md",
    "docs/guardrail-guide.md",
    "docs/incident/2026-08-09.md",
    "docs/migration-plan.md",
    "docs/oncall.md",
    "docs/operator/console.md",
    "docs/policy-overview.md",
    "docs/production-readiness.md",
    "docs/release_notes.md",
    "docs/rollback.md",
    "docs/runbook/setup.md",
    "docs/secret-handling.md",
    "docs/security.md",
    "docs/trading-strategy.md",
    "docs/workflows-map.md",
  ])("rejects %s", (filename) => {
    expect(isLowRiskPath(filename)).toBe(false);
  });

  it("requires at least one file and only added or modified statuses", () => {
    expect(isLowRiskChange([])).toBe(false);
    expect(
      isLowRiskChange([
        { filename: "docs/guide.md", status: "added" },
        { filename: "docs/image.png", status: "modified" },
      ]),
    ).toBe(true);

    for (const status of [
      "changed",
      "removed",
      "renamed",
      "copied",
      "unchanged",
    ]) {
      expect(
        isLowRiskChange([{ filename: "docs/guide.md", status }]),
      ).toBe(false);
    }
  });

  it("rejects an otherwise safe file moved from a sensitive path", () => {
    expect(
      isLowRiskChange([
        {
          filename: "docs/guide.md",
          previous_filename: "docs/security-guide.md",
          status: "modified",
        },
      ]),
    ).toBe(false);
  });
});

describe("deterministic merge policy", () => {
  it("allows an enrolled trusted agent only for a low-risk change", () => {
    expect(policy()).toMatchObject({
      state: "success",
      description: "Current-head agent reviews approve this PR",
      sameRepository: true,
      trustedAgent: true,
      lowRisk: true,
      hasBlockingLabel: false,
    });

    expect(
      policy({
        files: [{ filename: "src/agent/run.ts", status: "modified" }],
      }),
    ).toMatchObject({
      state: "pending",
      description: "Waiting for Trading safety review",
      lowRisk: false,
    });
  });

  it("accepts agent approval for a same-repository human author", () => {
    expect(
      policy({
        pullRequest: pullRequest({
          user: { login: "trusted-human", type: "User" },
        }),
      }),
    ).toMatchObject({
      state: "success",
      description: "Current-head agent reviews approve this PR",
      trustedAgent: false,
    });
  });

  it("still requires human approval for a fork", () => {
    expect(
      policy({
        pullRequest: pullRequest({
          head: {
            sha: "head-sha",
            ref: "docs/fork",
            repo: { full_name: "attacker/project-krypto-dog" },
          },
        }),
      }),
    ).toMatchObject({
      state: "pending",
      description: "A current human approval is required for forked changes",
      sameRepository: false,
      trustedAgent: false,
    });
  });

  it("accepts only a trusted human approval on the current head", () => {
    const highRiskFiles = [
      { filename: "src/trading/policy.ts", status: "modified" },
    ];

    expect(
      policy({ files: highRiskFiles, reviews: [review()] }),
    ).toMatchObject({
      state: "success",
      description: "Current human approval satisfies policy",
      hasCurrentHumanApproval: true,
    });

    for (const ineligibleReview of [
      review({ commit_id: "stale-sha" }),
      review({
        user: { login: "review-bot[bot]", type: "Bot" },
      }),
      review({ author_association: "CONTRIBUTOR" }),
      review({
        user: { login: "github-actions[bot]", type: "User" },
      }),
    ]) {
      expect(
        policy({
          files: highRiskFiles,
          reviews: [ineligibleReview],
        }),
      ).toMatchObject({
        state: "pending",
        hasCurrentHumanApproval: false,
      });
    }
  });

  it("lets the latest decisive review from one reviewer supersede its prior state", () => {
    expect(
      policy({
        files: [{ filename: "src/app.ts", status: "modified" }],
        reviews: [
          review({ state: "CHANGES_REQUESTED" }),
          review({ state: "APPROVED" }),
        ],
      }),
    ).toMatchObject({
      state: "success",
      hasCurrentHumanApproval: true,
      hasCurrentHumanChangesRequested: false,
    });
  });

  it("gives any current trusted change request veto priority", () => {
    expect(
      policy({
        reviews: [
          review({
            user: { login: "approver", type: "User" },
          }),
          review({
            state: "CHANGES_REQUESTED",
            user: { login: "requester", type: "User" },
          }),
        ],
      }),
    ).toMatchObject({
      state: "pending",
      description: "A current human review requests changes",
      hasCurrentHumanApproval: true,
      hasCurrentHumanChangesRequested: true,
    });
  });

  it.each([
    "blocked",
    "self-heal-exhausted",
    "needs-qa",
    "security-review",
    "trading-safety",
    "ready-for-human-review",
  ])("requires human approval when %s is present", (label) => {
    const result = policy({
      pullRequest: pullRequest({
        labels: [
          { name: "agentic-automerge" },
          { name: label },
        ],
      }),
    });

    expect(result).toMatchObject({
      state: "pending",
      description: "A blocking review label requires changes",
      hasBlockingLabel: true,
    });
  });

  it("treats a mismatched docs-sync label as blocking", () => {
    expect(
      policy({
        pullRequest: pullRequest({
          title: "[ai-dev] Update a guide",
          labels: [
            { name: "agentic-automerge" },
            { name: "docs-sync" },
          ],
        }),
      }),
    ).toMatchObject({
      state: "pending",
      hasBlockingLabel: true,
    });

    expect(policy()).toMatchObject({
      state: "success",
      hasBlockingLabel: false,
    });
  });

  it("keeps draft pull requests pending", () => {
    expect(
      policy({ pullRequest: pullRequest({ draft: true }) }),
    ).toMatchObject({
      state: "pending",
      description: "Draft pull requests cannot merge",
    });
  });
});

describe("conditional specialist agent approval", () => {
  const passingCheck = (name: string, id: number): CheckRun => ({
    id,
    name,
    status: "completed",
    conclusion: "success",
  });

  it("maps security and workflow paths to Security review", () => {
    expect(
      getRequiredSpecialistChecks([
        {
          filename: ".github/workflows/ci.yml",
          status: "modified",
        },
        {
          filename: "src/app/api/auth/login/route.ts",
          status: "modified",
        },
      ]),
    ).toEqual(["Security review"]);
  });

  it("maps trading and database paths to Trading safety review", () => {
    expect(
      getRequiredSpecialistChecks([
        {
          filename: "src/trading/policy.ts",
          status: "modified",
        },
        {
          filename: "drizzle/0007_example.sql",
          status: "added",
        },
      ]),
    ).toEqual(["Trading safety review"]);
  });

  it("requires both specialists for cross-cutting agent changes", () => {
    const files = [
      {
        filename: ".github/workflows/ci.yml",
        status: "modified",
      },
      {
        filename: "src/agent/run-flow.ts",
        status: "modified",
      },
    ];
    const codeReview = passingCheck("Agentic code review", 1);
    const securityReview = passingCheck("Security review", 2);
    const tradingReview = passingCheck("Trading safety review", 3);

    expect(getAgentApprovalState(files, [codeReview])).toMatchObject({
      approved: false,
      waitingCheck: "Security review",
      requiredSpecialistChecks: [
        "Security review",
        "Trading safety review",
      ],
    });
    expect(
      getAgentApprovalState(files, [codeReview, securityReview]),
    ).toMatchObject({
      approved: false,
      waitingCheck: "Trading safety review",
    });
    expect(
      getAgentApprovalState(files, [
        codeReview,
        securityReview,
        tradingReview,
      ]),
    ).toMatchObject({
      approved: true,
      requiredSpecialistChecks: [
        "Security review",
        "Trading safety review",
      ],
    });
  });

  it("keeps policy pending when a required specialist fails", () => {
    const result = policy({
      files: [
        {
          filename: ".github/workflows/ci.yml",
          status: "modified",
        },
      ],
      checkRuns: [
        passingCheck("Agentic code review", 1),
        {
          id: 2,
          name: "Security review",
          status: "completed",
          conclusion: "failure",
        },
      ],
    });

    expect(result).toMatchObject({
      state: "pending",
      description: "Security review requires changes",
    });
  });

  it("allows policy when all current-head specialist checks pass", () => {
    const result = policy({
      files: [
        {
          filename: "src/db/schema.ts",
          status: "modified",
        },
      ],
      checkRuns: [
        passingCheck("Agentic code review", 1),
        passingCheck("Trading safety review", 2),
      ],
    });

    expect(result).toMatchObject({
      state: "success",
      description: "Current-head agent reviews approve this PR",
    });
  });
});

describe("bounded self-heal policy", () => {
  it("counts only trusted [self-heal] commits", () => {
    const commits: Commit[] = [
      {
        author: { login: "github-actions[bot]" },
        commit: { message: "docs: repair check [self-heal]" },
      },
      {
        author: { login: "copilot-swe-agent[bot]" },
        commit: { message: "docs: retry [self-heal]" },
      },
      {
        author: { login: "trusted-human" },
        commit: { message: "docs: manual repair [self-heal]" },
      },
      {
        author: { login: "github-actions[bot]" },
        commit: { message: "docs: normal update" },
      },
      {
        author: null,
        commit: { message: "anonymous [self-heal]" },
      },
    ];

    expect(countRepairAttempts(commits)).toBe(2);
  });

  it.each([
    ["cross-repository", { sameRepository: false }],
    ["draft", { draft: true }],
    ["untrusted", { trustedAgent: false }],
    ["non-low-risk", { lowRisk: false }],
    ["specialist-blocked", { hasBlockingLabel: true }],
    ["missing CI", { ciNeedsDispatch: true }],
    ["missing or held review", { reviewShouldDispatch: true }],
    ["held CI", { ciHeld: true }],
    ["held review", { reviewHeld: true }],
  ] as const)("does not self-heal a %s pull request", (_name, override) => {
    const eligible: SelfHealEligibility = {
      sameRepository: true,
      draft: false,
      trustedAgent: true,
      lowRisk: true,
      hasBlockingLabel: false,
      ciNeedsDispatch: false,
      reviewShouldDispatch: false,
      ciHeld: false,
      reviewHeld: false,
    };

    expect(
      canAttemptSelfHeal({ ...eligible, ...override }),
    ).toBe(false);
  });

  it("self-heals only when every deterministic prerequisite passes", () => {
    expect(
      canAttemptSelfHeal({
        sameRepository: true,
        draft: false,
        trustedAgent: true,
        lowRisk: true,
        hasBlockingLabel: false,
        ciNeedsDispatch: false,
        reviewShouldDispatch: false,
        ciHeld: false,
        reviewHeld: false,
      }),
    ).toBe(true);
  });

  it("does not treat action_required or a superseded CI failure as repairable", () => {
    expect(
      hasFailedCiRun([
        {
          id: 2,
          status: "completed",
          conclusion: "action_required",
        },
      ]),
    ).toBe(false);
    expect(
      hasFailedCiRun([
        { id: 2, status: "completed", conclusion: "success" },
        { id: 1, status: "completed", conclusion: "failure" },
      ]),
    ).toBe(false);
    expect(
      hasFailedCiRun([
        { id: 3, status: "completed", conclusion: "failure" },
      ]),
    ).toBe(true);

    expect(
      hasFailedReviewCheck([
        {
          id: 4,
          name: "Agentic code review",
          status: "completed",
          conclusion: "action_required",
        },
      ]),
    ).toBe(false);
  });
});
