export {};

interface PullRequest {
  number: number;
  title: string;
  draft: boolean;
  html_url: string;
  body: string;
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
  riskTier: string;
  requiresHumanBoundaryApproval: boolean;
  factoryMode: string;
  factoryModeBlocksAction: boolean;
  agentImplementationProvenance: boolean;
  requiresVerifiedAgentProvenance: boolean;
  implementationScopeValid: boolean;
}

interface SelfHealEligibility {
  sameRepository: boolean;
  draft: boolean;
  trustedAgent: boolean;
  lowRisk: boolean;
  riskTier?: string;
  hasBlockingLabel: boolean;
  ciNeedsDispatch: boolean;
  reviewShouldDispatch: boolean;
  ciHeld: boolean;
  reviewHeld: boolean;
  specialistReviewPending?: boolean;
}

interface ReconcilerModule {
  canAttemptSelfHeal(input: SelfHealEligibility): boolean;
  countRepairAttempts(commits: Commit[]): number;
  getRepairAttemptLimit(riskTier: string): number;
  evaluateMergePolicy(input: {
    pullRequest: PullRequest;
    files: ChangedFile[];
    reviews: Review[];
    checkRuns?: CheckRun[];
    repository: string;
    factoryMode?: string;
    agentImplementationProvenance?: boolean;
    issueRiskLabel?: string;
    issueAllowedPaths?: string[];
    goalMaxRiskTier?: string;
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
  getAgentImplementationReference(pullRequest: PullRequest): {
    required: boolean;
    valid: boolean;
    nonce?: string;
    issueNumber?: number;
  };
  getIssueFormSection(body: string, heading: string): string | undefined;
}

const {
  canAttemptSelfHeal,
  countRepairAttempts,
  evaluateMergePolicy,
  getAgentApprovalState,
  getAgentImplementationReference,
  getIssueFormSection,
  getRepairAttemptLimit,
  getRequiredSpecialistChecks,
  hasFailedCiRun,
  hasFailedReviewCheck,
  isLowRiskChange,
  isLowRiskPath,
  isTrustedAgentPullRequest,
} = jest.requireActual<ReconcilerModule>(
  "../../.github/scripts/agentic-pr-reconciler.cjs",
);

const repository = "VeVarunSharma/project-krypto-dog";

function pullRequest(
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return {
    number: 42,
    title: "[docs-sync] Refresh contributor guide",
    draft: false,
    html_url:
      "https://github.com/VeVarunSharma/project-krypto-dog/pull/42",
    body: "",
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

function passingCheck(name: string, id: number): CheckRun {
  return {
    id,
    name,
    status: "completed",
    conclusion: "success",
  };
}

function policy(
  overrides: {
    pullRequest?: PullRequest;
    files?: ChangedFile[];
    reviews?: Review[];
    checkRuns?: CheckRun[];
    factoryMode?: string;
    agentImplementationProvenance?: boolean;
    issueRiskLabel?: string;
    issueAllowedPaths?: string[];
    goalMaxRiskTier?: string;
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
    factoryMode: overrides.factoryMode,
    agentImplementationProvenance:
      overrides.agentImplementationProvenance,
    issueRiskLabel: overrides.issueRiskLabel,
    issueAllowedPaths: overrides.issueAllowedPaths,
    goalMaxRiskTier: overrides.goalMaxRiskTier,
  });
}

describe("trusted agent identity", () => {
  it.each([
    ["github-actions[bot]", "[docs-sync] Refresh contributor guide", ""],
    [
      "copilot-swe-agent[bot]",
      "[ai-dev] Refresh contributor guide",
      "<!-- factory-claim:run:1:42 -->\nRefs #42",
    ],
  ])(
    "trusts the enrolled same-repository %s identity only for its title class",
    (login, title, body) => {
      expect(
        isTrustedAgentPullRequest(
          pullRequest({
            user: { login, type: "Bot" },
            title,
            body,
          }),
          repository.toUpperCase(),
        ),
      ).toBe(true);
    },
  );

  it("parses exactly one implementation claim and issue reference", () => {
    expect(
      getAgentImplementationReference(
        pullRequest({
          user: { login: "copilot-swe-agent[bot]", type: "Bot" },
          title: "[ai-dev] Implement",
          body: "<!-- factory-claim:run:1:42 -->\nRefs #42",
          labels: [
            { name: "agentic-factory" },
            { name: "agentic-automerge" },
            { name: "risk:routine" },
          ],
        }),
      ),
    ).toEqual({
      required: true,
      valid: true,
      nonce: "run:1:42",
      issueNumber: 42,
    });

    expect(
      getAgentImplementationReference(
        pullRequest({
          title: "[ai-dev] Missing claim",
          body: "Refs #42",
        }),
      ),
    ).toEqual({ required: true, valid: false });
  });

  it("reads rendered issue-form sections exactly", () => {
    expect(
      getIssueFormSection(
        "### Scope and non-goals\n\nOne file.\n\n### Allowed paths\n\ndocs/**",
        "Allowed paths",
      ),
    ).toBe("docs/**");
    expect(
      getIssueFormSection(
        "### Allowed paths\n\ndocs/**\n\n### Allowed paths\n\nsrc/**",
        "Allowed paths",
      ),
    ).toBeUndefined();
  });

  it("does not let one trusted bot impersonate the other workflow class", () => {
    expect(
      isTrustedAgentPullRequest(
        pullRequest({
          user: { login: "github-actions[bot]", type: "Bot" },
          title: "[ai-dev] Unverified implementation",
        }),
        repository,
      ),
    ).toBe(false);
    expect(
      isTrustedAgentPullRequest(
        pullRequest({
          user: { login: "copilot-swe-agent[bot]", type: "Bot" },
          title: "[docs-sync] Unverified docs",
        }),
        repository,
      ),
    ).toBe(false);
  });

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
  it("allows routine work and waits for sensitive-work checks", () => {
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
      description: "Waiting for QA verification",
      lowRisk: false,
      riskTier: "risk:sensitive",
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

  it("requires current-head agent checks plus trusted human approval for boundary work", () => {
    const boundaryFiles = [
      { filename: ".github/workflows/ci.yml", status: "modified" },
    ];
    const boundaryChecks = [
      passingCheck("Agentic code review", 1),
      passingCheck("QA verification", 2),
      passingCheck("Security review", 3),
    ];

    expect(
      policy({
        files: boundaryFiles,
        reviews: [review()],
        checkRuns: boundaryChecks,
      }),
    ).toMatchObject({
      state: "success",
      description: "Current-head human and agent reviews approve boundary PR",
      hasCurrentHumanApproval: true,
      riskTier: "risk:boundary",
      requiresHumanBoundaryApproval: true,
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
          files: boundaryFiles,
          reviews: [ineligibleReview],
          checkRuns: boundaryChecks,
        }),
      ).toMatchObject({
        state: "pending",
        description: "Boundary change requires current human approval",
        hasCurrentHumanApproval: false,
      });
    }
  });

  it("lets the latest decisive review from one reviewer supersede its prior state", () => {
    expect(
      policy({
        files: [{ filename: "README.md", status: "modified" }],
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

  it.each(["blocked", "self-heal-exhausted"])(
    "keeps hard blocker %s pending",
    (label) => {
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
    },
  );

  it.each([
    ["needs-qa", "QA verification"],
    ["security-review", "Security review"],
    ["trading-safety", "Trading safety review"],
  ])("uses transient %s as a required current-head check", (label, checkName) => {
    const request = pullRequest({
      labels: [
        { name: "agentic-automerge" },
        { name: label },
      ],
    });

    expect(policy({ pullRequest: request })).toMatchObject({
      state: "pending",
      description: `Waiting for ${checkName}`,
      hasBlockingLabel: true,
    });
    expect(
      policy({
        pullRequest: request,
        checkRuns: [
          passingCheck("Agentic code review", 1),
          passingCheck(checkName, 2),
        ],
      }),
    ).toMatchObject({
      state: "success",
      hasBlockingLabel: false,
    });
  });

  it("keeps an emitted review check durable even without its requirement label", () => {
    expect(
      policy({
        pullRequest: pullRequest({
          labels: [
            { name: "agentic-factory" },
            { name: "agentic-automerge" },
          ],
        }),
        checkRuns: [
          passingCheck("Agentic code review", 1),
          {
            id: 2,
            name: "QA verification",
            status: "completed",
            conclusion: "failure",
          },
        ],
      }),
    ).toMatchObject({
      state: "pending",
      description: "QA verification requires changes",
    });
  });

  it("treats ready-for-human-review as a boundary escalation", () => {
    const escalated = pullRequest({
      labels: [
        { name: "agentic-automerge" },
        { name: "ready-for-human-review" },
      ],
    });
    const checks = [
      passingCheck("Agentic code review", 1),
      passingCheck("QA verification", 2),
    ];
    expect(policy({ pullRequest: escalated, checkRuns: checks })).toMatchObject({
      state: "pending",
      description: "Boundary change requires current human approval",
      riskTier: "risk:boundary",
    });
    expect(
      policy({
        pullRequest: escalated,
        checkRuns: checks,
        reviews: [review()],
      }),
    ).toMatchObject({
      state: "success",
      description: "Current-head human and agent reviews approve boundary PR",
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

  it("fails closed when an implementation PR lacks verified claim provenance", () => {
    expect(
      policy({
        pullRequest: pullRequest({
          user: { login: "copilot-swe-agent[bot]", type: "Bot" },
          title: "[ai-dev] Implement",
          body: "<!-- factory-claim:run:1:42 -->\nRefs #42",
          labels: [
            { name: "agentic-factory" },
            { name: "agentic-automerge" },
            { name: "risk:routine" },
          ],
        }),
        agentImplementationProvenance: false,
      }),
    ).toMatchObject({
      state: "pending",
      description: "Factory claim provenance is invalid",
      requiresVerifiedAgentProvenance: true,
      riskExceedsGoal: false,
    });
  });

  it("inherits and cannot lower the claimed issue risk tier", () => {
    const implementation = pullRequest({
      user: { login: "copilot-swe-agent[bot]", type: "Bot" },
      title: "[ai-dev] Implement",
      body: "<!-- factory-claim:run:1:42 -->\nRefs #42",
      labels: [
        { name: "agentic-factory" },
        { name: "agentic-automerge" },
        { name: "risk:routine" },
      ],
    });
    expect(
      policy({
        pullRequest: implementation,
        issueRiskLabel: "risk:boundary",
        issueAllowedPaths: ["docs/**"],
        goalMaxRiskTier: "risk:boundary",
        checkRuns: [
          passingCheck("Agentic code review", 1),
          passingCheck("QA verification", 2),
        ],
      }),
    ).toMatchObject({
      state: "pending",
      description: "Boundary change requires current human approval",
      riskTier: "risk:boundary",
    });

  });

  it("blocks an implementation diff that escapes the issue allowed paths", () => {
    expect(
      policy({
        pullRequest: pullRequest({
          user: { login: "copilot-swe-agent[bot]", type: "Bot" },
          title: "[ai-dev] Implement",
          body: "<!-- factory-claim:run:1:42 -->\nRefs #42",
          labels: [
            { name: "agentic-factory" },
            { name: "agentic-automerge" },
            { name: "risk:routine" },
          ],
        }),
        issueRiskLabel: "risk:routine",
        issueAllowedPaths: ["docs/e2e/factory-full-heartbeat.md"],
        files: [
          {
            filename: "src/trading/policy.ts",
            status: "modified",
          },
        ],
      }),
    ).toMatchObject({
      state: "pending",
      description: "PR changes escape issue allowed paths",
      implementationScopeValid: false,
    });
  });

  it.each([
    ["shadow", "Factory shadow mode does not authorize merge"],
    ["paused", "Factory is paused"],
  ])("blocks enrolled PRs while factory mode is %s", (factoryMode, description) => {
    expect(policy({ factoryMode })).toMatchObject({
      state: "pending",
      description,
      factoryModeBlocksAction: true,
    });
    expect(
      policy({
        factoryMode,
        pullRequest: pullRequest({
          labels: [{ name: "agentic-factory" }],
          user: { login: "trusted-human", type: "User" },
        }),
      }),
    ).toMatchObject({
      state: "success",
      factoryModeBlocksAction: false,
    });
  });
});

describe("conditional specialist agent approval", () => {
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
    const qaReview = passingCheck("QA verification", 2);
    const securityReview = passingCheck("Security review", 3);
    const tradingReview = passingCheck("Trading safety review", 4);

    expect(getAgentApprovalState(files, [codeReview])).toMatchObject({
      approved: false,
      waitingCheck: "QA verification",
      requiredSpecialistChecks: [
        "QA verification",
        "Security review",
        "Trading safety review",
      ],
    });
    expect(
      getAgentApprovalState(files, [codeReview, qaReview, securityReview]),
    ).toMatchObject({
      approved: false,
      waitingCheck: "Trading safety review",
    });
    expect(
      getAgentApprovalState(files, [
        codeReview,
        qaReview,
        securityReview,
        tradingReview,
      ]),
    ).toMatchObject({
      approved: true,
      requiredSpecialistChecks: [
        "QA verification",
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
        passingCheck("QA verification", 2),
        {
          id: 3,
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
        passingCheck("QA verification", 2),
        passingCheck("Trading safety review", 3),
      ],
    });

    expect(result).toMatchObject({
      state: "success",
      description: "Current-head agent reviews approve this PR",
    });
  });
});

describe("bounded self-heal policy", () => {
  it("caps routine at two, sensitive at one, and boundary at zero", () => {
    expect(getRepairAttemptLimit("risk:routine")).toBe(2);
    expect(getRepairAttemptLimit("risk:sensitive")).toBe(1);
    expect(getRepairAttemptLimit("risk:boundary")).toBe(0);
    expect(getRepairAttemptLimit("risk:unknown")).toBe(0);
  });

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
    ["pending specialist review", { specialistReviewPending: true }],
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

  it("allows sensitive repair only when every other eligibility gate passes", () => {
    expect(
      canAttemptSelfHeal({
        sameRepository: true,
        draft: false,
        trustedAgent: true,
        lowRisk: false,
        riskTier: "risk:sensitive",
        hasBlockingLabel: false,
        ciNeedsDispatch: false,
        reviewShouldDispatch: false,
        ciHeld: false,
        reviewHeld: false,
        specialistReviewPending: false,
      }),
    ).toBe(true);
    expect(
      canAttemptSelfHeal({
        sameRepository: true,
        draft: false,
        trustedAgent: true,
        lowRisk: false,
        riskTier: "risk:boundary",
        hasBlockingLabel: false,
        ciNeedsDispatch: false,
        reviewShouldDispatch: false,
        ciHeld: false,
        reviewHeld: false,
        specialistReviewPending: false,
      }),
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
