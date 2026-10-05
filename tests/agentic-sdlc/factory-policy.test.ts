export {};

interface MigrationFile {
  filename: string;
  patch?: string;
  content?: string;
}

interface RiskInput {
  files?: MigrationFile[];
  issueRiskLabel?: string;
}

interface RiskResult {
  tier: string;
  pathTier: string;
  issueTier: string | null;
  issueRiskValid: boolean;
  reasons: string[];
  destructiveMigrations: Array<{ filename: string; matches: string[] }>;
  requiredChecks: string[];
  requiresHumanBoundaryApproval: boolean;
}

interface LifecycleTransitionResult {
  allowed: boolean;
  from: string;
  to: string;
  owner?: string;
  reason?: string;
}

interface FactoryPolicyModule {
  FACTORY_MODES: { SHADOW: string; ACTIVE: string; PAUSED: string };
  resolveFactoryModeFromLabels(labels: unknown): string;
  RISK_TIERS: { ROUTINE: string; SENSITIVE: string; BOUNDARY: string };
  RISK_TIER_ORDER: string[];
  rankRiskTier(tier: string): number;
  isKnownRiskTier(tier: unknown): boolean;
  compareRiskTiers(left: string, right: string): number;
  maxRiskTier(left: string, right: string): string;
  classifyPathTier(filename: unknown): string;
  normalizeAllowedPathPatterns(value: unknown): {
    valid: boolean;
    patterns: string[];
    reason?: string;
  };
  isPathAllowed(filename: string, patterns: string[]): boolean;
  areChangedFilesWithinAllowedPaths(
    files: Array<{ filename: string; previous_filename?: string }>,
    patterns: string[],
  ): boolean;
  areAllowedPathPatternsWithin(
    childPatterns: string[],
    parentPatterns: string[],
  ): boolean;
  detectDestructiveMigrationStatements(file: MigrationFile): string[];
  determinePathRisk(files: unknown): {
    tier: string;
    reasons: string[];
    destructiveMigrations: Array<{ filename: string; matches: string[] }>;
  };
  normalizeIssueRiskLabel(label: unknown): {
    tier: string | null;
    valid: boolean;
    provided: boolean;
  };
  determineRiskTier(input: RiskInput): RiskResult;
  QUALITY_GATES_CHECK: string;
  MIGRATIONS_CHECK: string;
  CODE_REVIEW_CHECK: string;
  QA_CHECK: string;
  SECURITY_CHECK: string;
  TRADING_SAFETY_CHECK: string;
  BASELINE_REQUIRED_CHECKS: string[];
  requiresSecurityCheck(filename: string): boolean;
  requiresTradingSafetyCheck(filename: string): boolean;
  getRequiredChecks(tier: string, files?: MigrationFile[]): string[];
  requiresHumanBoundaryApproval(tier: string): boolean;
  LIFECYCLE_STATES: Record<string, string>;
  BLOCKING_LIFECYCLE_STATE: string;
  LIFECYCLE_TRANSITIONS: Array<{ from: string; to: string; owner: string }>;
  isLegalLifecycleTransition(from: string, to: string): boolean;
  getLifecycleTransitionOwner(from: string, to: string): string | undefined;
  applyLifecycleTransition(input: {
    from: string;
    to: string;
    actor?: string;
  }): LifecycleTransitionResult;
  QUEUE_READY_LABEL: string;
  BLOCKING_QUEUE_LABELS: string[];
}

const policy = jest.requireActual<FactoryPolicyModule>(
  "../../.github/scripts/agentic-factory-policy.cjs",
);

const { RISK_TIERS, LIFECYCLE_STATES } = policy;

function file(filename: string, extra: Partial<MigrationFile> = {}): MigrationFile {
  return { filename, ...extra };
}

describe("risk tier ordering and comparisons", () => {
  it("orders tiers from least to most conservative", () => {
    expect(policy.RISK_TIER_ORDER).toEqual([
      RISK_TIERS.ROUTINE,
      RISK_TIERS.SENSITIVE,
      RISK_TIERS.BOUNDARY,
    ]);
  });

  describe("factory mode labels", () => {
    it("resolves exactly one known mode and otherwise pauses", () => {
      expect(
        policy.resolveFactoryModeFromLabels(["factory-mode:active"]),
      ).toBe(policy.FACTORY_MODES.ACTIVE);
      expect(
        policy.resolveFactoryModeFromLabels([{ name: "factory-mode:shadow" }]),
      ).toBe(policy.FACTORY_MODES.SHADOW);
      expect(policy.resolveFactoryModeFromLabels([])).toBe(
        policy.FACTORY_MODES.PAUSED,
      );
      expect(
        policy.resolveFactoryModeFromLabels([
          "factory-mode:active",
          "factory-mode:shadow",
        ]),
      ).toBe(policy.FACTORY_MODES.PAUSED);
      expect(policy.resolveFactoryModeFromLabels(undefined)).toBe(
        policy.FACTORY_MODES.PAUSED,
      );
    });
  });

  it("ranks known tiers and rejects unknown ones", () => {
    expect(policy.rankRiskTier(RISK_TIERS.ROUTINE)).toBe(0);
    expect(policy.rankRiskTier(RISK_TIERS.SENSITIVE)).toBe(1);
    expect(policy.rankRiskTier(RISK_TIERS.BOUNDARY)).toBe(2);
    expect(policy.rankRiskTier("risk:unknown")).toBe(-1);
    expect(policy.isKnownRiskTier("risk:unknown")).toBe(false);
    expect(policy.isKnownRiskTier(RISK_TIERS.SENSITIVE)).toBe(true);
  });

  it("compares tiers consistently with rank order", () => {
    expect(policy.compareRiskTiers(RISK_TIERS.ROUTINE, RISK_TIERS.BOUNDARY)).toBeLessThan(0);
    expect(policy.compareRiskTiers(RISK_TIERS.BOUNDARY, RISK_TIERS.ROUTINE)).toBeGreaterThan(0);
    expect(policy.compareRiskTiers(RISK_TIERS.SENSITIVE, RISK_TIERS.SENSITIVE)).toBe(0);
  });

  it("never lowers risk when computing the max of two tiers", () => {
    expect(policy.maxRiskTier(RISK_TIERS.ROUTINE, RISK_TIERS.SENSITIVE)).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.maxRiskTier(RISK_TIERS.BOUNDARY, RISK_TIERS.ROUTINE)).toBe(RISK_TIERS.BOUNDARY);
    expect(policy.maxRiskTier(RISK_TIERS.SENSITIVE, RISK_TIERS.SENSITIVE)).toBe(RISK_TIERS.SENSITIVE);
  });
});

describe("minimum-risk path classification", () => {
  it("classifies ordinary UI, tests, and non-sensitive docs as routine", () => {
    expect(policy.classifyPathTier("src/app/dashboard/page.tsx")).toBe(RISK_TIERS.ROUTINE);
    expect(policy.classifyPathTier("src/components/krypto/PortfolioCard.tsx")).toBe(
      RISK_TIERS.ROUTINE,
    );
    expect(policy.classifyPathTier("tests/ui/page.test.ts")).toBe(RISK_TIERS.ROUTINE);
    expect(policy.classifyPathTier("docs/onboarding-guide.md")).toBe(RISK_TIERS.ROUTINE);
    expect(policy.classifyPathTier("README.md")).toBe(RISK_TIERS.ROUTINE);
  });

  describe("deterministic allowed-path scope", () => {
    it("accepts exact paths and terminal directory globs", () => {
      const parsed = policy.normalizeAllowedPathPatterns(
        "- `src/components/card.tsx`\n- tests/ui/**",
      );
      expect(parsed).toEqual({
        valid: true,
        patterns: ["src/components/card.tsx", "tests/ui/**"],
      });
      expect(
        policy.isPathAllowed(
          "src/components/card.tsx",
          parsed.patterns,
        ),
      ).toBe(true);
      expect(policy.isPathAllowed("tests/ui/card.test.ts", parsed.patterns)).toBe(
        true,
      );
      expect(policy.isPathAllowed("src/trading/policy.ts", parsed.patterns)).toBe(
        false,
      );
    });

    it.each([
      "",
      "../src/**",
      "/src/**",
      "src\\file.ts",
      "src/*.ts",
      "src/**/file.ts",
    ])("rejects ambiguous or unsafe allowed path %s", (value) => {
      expect(policy.normalizeAllowedPathPatterns(value).valid).toBe(false);
    });

    it("checks renamed paths on both sides of the change", () => {
      expect(
        policy.areChangedFilesWithinAllowedPaths(
          [
            {
              filename: "docs/new.md",
              previous_filename: "docs/old.md",
            },
          ],
          ["docs/**"],
        ),
      ).toBe(true);
      expect(
        policy.areChangedFilesWithinAllowedPaths(
          [
            {
              filename: "docs/new.md",
              previous_filename: "src/old.ts",
            },
          ],
          ["docs/**"],
        ),
      ).toBe(false);
    });

    it("requires child issue patterns to stay within goal patterns", () => {
      expect(
        policy.areAllowedPathPatternsWithin(
          ["src/components/card.tsx", "tests/ui/**"],
          ["src/components/**", "tests/**"],
        ),
      ).toBe(true);
      expect(
        policy.areAllowedPathPatternsWithin(
          ["src/**"],
          ["src/components/**"],
        ),
      ).toBe(false);
      expect(
        policy.areAllowedPathPatternsWithin(
          ["src/components/card.tsx"],
          ["src/components/other.tsx"],
        ),
      ).toBe(false);
    });
  });

  it("raises safety-critical tests and factory policy documentation above routine", () => {
    expect(policy.classifyPathTier("tests/agent/decision.test.ts")).toBe(
      RISK_TIERS.SENSITIVE,
    );
    expect(policy.classifyPathTier("tests/guardrails/drawdown.test.ts")).toBe(
      RISK_TIERS.SENSITIVE,
    );
    expect(policy.classifyPathTier("docs/agentic-software-factory.md")).toBe(
      RISK_TIERS.BOUNDARY,
    );
    expect(policy.classifyPathTier("specs/factory.md")).toBe(
      RISK_TIERS.BOUNDARY,
    );
    expect(policy.classifyPathTier("specs/governance.md")).toBe(
      RISK_TIERS.BOUNDARY,
    );
    expect(policy.classifyPathTier("specs/product.md")).toBe(
      RISK_TIERS.SENSITIVE,
    );
    expect(policy.classifyPathTier("specs/operations.md")).toBe(
      RISK_TIERS.SENSITIVE,
    );
    expect(policy.classifyPathTier("specs/evaluation.md")).toBe(
      RISK_TIERS.SENSITIVE,
    );
  });

  it("classifies reversible trading, guardrail, auth, db/migration, agent, deployment, dependency, and infra code as sensitive", () => {
    expect(policy.classifyPathTier("src/trading/policy.ts")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("src/guardrails/drawdown.ts")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("src/lib/admin-auth.ts")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("src/db/schema.ts")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("drizzle/0001_init.sql")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("supabase/migrations/0002_add_column.sql")).toBe(
      RISK_TIERS.SENSITIVE,
    );
    expect(policy.classifyPathTier("src/agent/decision.ts")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("src/deployment/preflight.ts")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("package.json")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("scripts/evidence.ts")).toBe(
      RISK_TIERS.SENSITIVE,
    );
    expect(policy.classifyPathTier("tsconfig.scripts.json")).toBe(
      RISK_TIERS.SENSITIVE,
    );
    expect(policy.classifyPathTier("jest.config.ts")).toBe(
      RISK_TIERS.SENSITIVE,
    );
    expect(policy.classifyPathTier("Dockerfile")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("DESIGN.md")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("infra/bicep/main.bicep")).toBe(RISK_TIERS.SENSITIVE);
    expect(policy.classifyPathTier("docs/deployment-runbook.md")).toBe(RISK_TIERS.SENSITIVE);
  });

  it("classifies factory control-plane, agent/skill definitions, and unknown paths as boundary", () => {
    expect(policy.classifyPathTier(".github/workflows/ci.yml")).toBe(RISK_TIERS.BOUNDARY);
    expect(policy.classifyPathTier(".github/scripts/agentic-pr-reconciler.cjs")).toBe(
      RISK_TIERS.BOUNDARY,
    );
    expect(policy.classifyPathTier(".github/agents/project-krypto-dev.md")).toBe(
      RISK_TIERS.BOUNDARY,
    );
    expect(policy.classifyPathTier(".github/skills/some-skill/SKILL.md")).toBe(
      RISK_TIERS.BOUNDARY,
    );
    expect(policy.classifyPathTier("docs/branch-protection.md")).toBe(RISK_TIERS.BOUNDARY);
    expect(policy.classifyPathTier("specs/governance.md")).toBe(
      RISK_TIERS.BOUNDARY,
    );
    expect(policy.classifyPathTier("infra/iam/role-assignment.bicep")).toBe(RISK_TIERS.BOUNDARY);
    expect(policy.classifyPathTier("some/totally/unrecognized/path.xyz")).toBe(
      RISK_TIERS.BOUNDARY,
    );
  });

  it("does not classify all ordinary app source as boundary", () => {
    const appSourceFiles = [
      "src/app/page.tsx",
      "src/app/admin/dashboard/page.tsx",
      "src/components/ui/button.tsx",
      "src/trading/accounting.ts",
      "src/lib/config.ts",
    ];
    for (const filename of appSourceFiles) {
      expect(policy.classifyPathTier(filename)).not.toBe(RISK_TIERS.BOUNDARY);
    }
  });

  it("fails closed to boundary for malformed filenames", () => {
    expect(policy.classifyPathTier("")).toBe(RISK_TIERS.BOUNDARY);
    expect(policy.classifyPathTier(undefined)).toBe(RISK_TIERS.BOUNDARY);
    expect(policy.classifyPathTier(null)).toBe(RISK_TIERS.BOUNDARY);
    expect(policy.classifyPathTier(42)).toBe(RISK_TIERS.BOUNDARY);
  });
});

describe("destructive migration detection", () => {
  it("detects DROP TABLE/COLUMN/SCHEMA, TRUNCATE, destructive ALTER TYPE, and REVOKE/GRANT broadening", () => {
    expect(
      policy.detectDestructiveMigrationStatements(
        file("supabase/migrations/0001.sql", { content: "DROP TABLE accounts;" }),
      ),
    ).toContain("drop-table");
    expect(
      policy.detectDestructiveMigrationStatements(
        file("supabase/migrations/0002.sql", {
          content: "ALTER TABLE accounts DROP COLUMN legacy_field;",
        }),
      ),
    ).toContain("drop-column");
    expect(
      policy.detectDestructiveMigrationStatements(
        file("supabase/migrations/0003.sql", { content: "DROP SCHEMA legacy CASCADE;" }),
      ),
    ).toContain("drop-schema");
    expect(
      policy.detectDestructiveMigrationStatements(
        file("supabase/migrations/0004.sql", { content: "TRUNCATE accounts;" }),
      ),
    ).toContain("truncate");
    expect(
      policy.detectDestructiveMigrationStatements(
        file("supabase/migrations/0005.sql", {
          content: "ALTER TABLE accounts ALTER COLUMN balance TYPE integer;",
        }),
      ),
    ).toContain("destructive-alter-type");
    expect(
      policy.detectDestructiveMigrationStatements(
        file("supabase/migrations/0006.sql", { content: "REVOKE ALL ON accounts FROM app_role;" }),
      ),
    ).toContain("revoke");
    expect(
      policy.detectDestructiveMigrationStatements(
        file("supabase/migrations/0007.sql", { content: "GRANT ALL ON accounts TO PUBLIC;" }),
      ),
    ).toContain("grant-broadening");
  });

  it("only scans added lines when given a patch", () => {
    const patch = [
      "@@ -1,3 +1,3 @@",
      "-DROP TABLE accounts;",
      "+SELECT 1;",
      " -- unrelated context line",
    ].join("\n");
    expect(
      policy.detectDestructiveMigrationStatements(file("supabase/migrations/0008.sql", { patch })),
    ).toEqual([]);
  });

  it("does not flag non-destructive migrations or non-migration files", () => {
    expect(
      policy.detectDestructiveMigrationStatements(
        file("supabase/migrations/0009.sql", { content: "CREATE TABLE accounts (id uuid);" }),
      ),
    ).toEqual([]);
    expect(
      policy.detectDestructiveMigrationStatements(
        file("src/trading/policy.ts", { content: "DROP TABLE accounts;" }),
      ),
    ).toEqual([]);
  });

  it("raises the overall tier to boundary when a destructive migration is present", () => {
    const result = policy.determinePathRisk([
      file("supabase/migrations/0010.sql", { content: "DROP TABLE accounts;" }),
    ]);
    expect(result.tier).toBe(RISK_TIERS.BOUNDARY);
    expect(result.destructiveMigrations).toEqual([
      { filename: "supabase/migrations/0010.sql", matches: ["drop-table"] },
    ]);
  });

  it("fails closed when migration content is unavailable", () => {
    const result = policy.determinePathRisk([
      file("drizzle/0011_unknown.sql"),
    ]);
    expect(result.tier).toBe(RISK_TIERS.BOUNDARY);
    expect(result.reasons).toContain(
      "migration-content-unavailable:drizzle/0011_unknown.sql",
    );
  });
});

describe("aggregate risk tier: raise-not-lower and fail-closed behavior", () => {
  it("raises risk tier based on the most conservative changed path", () => {
    const result = policy.determineRiskTier({
      files: [file("README.md"), file("src/trading/policy.ts"), file(".github/workflows/ci.yml")],
    });
    expect(result.pathTier).toBe(RISK_TIERS.BOUNDARY);
    expect(result.tier).toBe(RISK_TIERS.BOUNDARY);
  });

  it("lets issue-declared risk raise the tier above the path-derived tier", () => {
    const result = policy.determineRiskTier({
      files: [file("README.md")],
      issueRiskLabel: RISK_TIERS.SENSITIVE,
    });
    expect(result.pathTier).toBe(RISK_TIERS.ROUTINE);
    expect(result.issueTier).toBe(RISK_TIERS.SENSITIVE);
    expect(result.tier).toBe(RISK_TIERS.SENSITIVE);
  });

  it("never lets issue-declared risk lower the path-derived tier", () => {
    const result = policy.determineRiskTier({
      files: [file("src/trading/policy.ts")],
      issueRiskLabel: RISK_TIERS.ROUTINE,
    });
    expect(result.pathTier).toBe(RISK_TIERS.SENSITIVE);
    expect(result.issueTier).toBe(RISK_TIERS.ROUTINE);
    expect(result.tier).toBe(RISK_TIERS.SENSITIVE);
  });

  it("fails closed to boundary for an unknown/invalid issue-declared tier", () => {
    const result = policy.determineRiskTier({
      files: [file("README.md")],
      issueRiskLabel: "risk:nonsense",
    });
    expect(result.issueRiskValid).toBe(false);
    expect(result.tier).toBe(RISK_TIERS.BOUNDARY);
    expect(result.reasons).toContain("invalid-issue-risk-label");
  });

  it("fails closed to boundary for a malformed or empty file list", () => {
    expect(policy.determineRiskTier({ files: [] }).tier).toBe(RISK_TIERS.BOUNDARY);
    expect(policy.determineRiskTier({ files: undefined }).tier).toBe(RISK_TIERS.BOUNDARY);
    expect(policy.determineRiskTier({ files: "not-an-array" as unknown as [] }).tier).toBe(
      RISK_TIERS.BOUNDARY,
    );
    expect(
      policy.determineRiskTier({ files: [{ filename: "" }] as unknown as [] }).tier,
    ).toBe(RISK_TIERS.BOUNDARY);
  });

  it("reports the human boundary approval flag only at the boundary tier", () => {
    expect(policy.determineRiskTier({ files: [file("README.md")] }).requiresHumanBoundaryApproval).toBe(
      false,
    );
    expect(
      policy.determineRiskTier({ files: [file(".github/workflows/ci.yml")] })
        .requiresHumanBoundaryApproval,
    ).toBe(true);
  });
});

describe("required checks", () => {
  it("always requires the baseline checks", () => {
    const checks = policy.getRequiredChecks(RISK_TIERS.ROUTINE, [file("README.md")]);
    expect(checks).toEqual(
      expect.arrayContaining([
        policy.QUALITY_GATES_CHECK,
        policy.MIGRATIONS_CHECK,
        policy.CODE_REVIEW_CHECK,
      ]),
    );
    expect(checks).not.toContain(policy.QA_CHECK);
  });

  it("adds QA verification for sensitive and boundary tiers", () => {
    expect(policy.getRequiredChecks(RISK_TIERS.SENSITIVE, [])).toContain(policy.QA_CHECK);
    expect(policy.getRequiredChecks(RISK_TIERS.BOUNDARY, [])).toContain(policy.QA_CHECK);
    expect(policy.getRequiredChecks(RISK_TIERS.ROUTINE, [])).not.toContain(policy.QA_CHECK);
  });

  it("selects the security specialist check from changed paths", () => {
    expect(policy.requiresSecurityCheck("src/app/api/admin/route.ts")).toBe(true);
    expect(policy.requiresSecurityCheck("src/proxy.ts")).toBe(true);
    expect(policy.requiresSecurityCheck("specs/product.md")).toBe(true);
    expect(policy.requiresSecurityCheck("specs/operations.md")).toBe(true);
    expect(policy.requiresSecurityCheck("specs/factory.md")).toBe(true);
    expect(policy.requiresSecurityCheck("specs/governance.md")).toBe(true);
    expect(policy.requiresSecurityCheck("src/components/ui/button.tsx")).toBe(false);
    const checks = policy.getRequiredChecks(RISK_TIERS.SENSITIVE, [
      file("src/app/api/admin/route.ts"),
    ]);
    expect(checks).toContain(policy.SECURITY_CHECK);
  });

  it("selects the trading-safety specialist check from changed paths", () => {
    expect(policy.requiresTradingSafetyCheck("src/trading/policy.ts")).toBe(true);
    expect(policy.requiresTradingSafetyCheck("supabase/migrations/0001.sql")).toBe(true);
    expect(policy.requiresTradingSafetyCheck("src/components/ui/button.tsx")).toBe(false);
    const checks = policy.getRequiredChecks(RISK_TIERS.SENSITIVE, [file("src/trading/policy.ts")]);
    expect(checks).toContain(policy.TRADING_SAFETY_CHECK);
  });

  it.each([
    "specs/product.md",
    "specs/operations.md",
    "specs/evaluation.md",
    "specs/factory.md",
    "specs/governance.md",
  ])("requires trading-safety review for canonical safety spec %s", (filename) => {
    expect(policy.requiresTradingSafetyCheck(filename)).toBe(true);
    expect(
      policy.getRequiredChecks(
        policy.classifyPathTier(filename),
        [file(filename)],
      ),
    ).toContain(policy.TRADING_SAFETY_CHECK);
  });

  it("requires human boundary approval only at the boundary tier", () => {
    expect(policy.requiresHumanBoundaryApproval(RISK_TIERS.BOUNDARY)).toBe(true);
    expect(policy.requiresHumanBoundaryApproval(RISK_TIERS.SENSITIVE)).toBe(false);
    expect(policy.getRequiredChecks(RISK_TIERS.BOUNDARY, [])).toContain(
      policy.QA_CHECK,
    );
  });

  it("deduplicates required checks", () => {
    const checks = policy.getRequiredChecks(RISK_TIERS.BOUNDARY, [
      file(".github/workflows/ci.yml"),
      file("src/trading/policy.ts"),
      file("src/trading/accounting.ts"),
    ]);
    expect(new Set(checks).size).toBe(checks.length);
  });

  it("fails closed to the boundary check set for an unknown tier", () => {
    const checks = policy.getRequiredChecks("risk:unknown" as string, []);
    expect(checks).toContain(policy.QA_CHECK);
  });
});

describe("lifecycle transitions", () => {
  it("exposes the blocking lifecycle state", () => {
    expect(policy.BLOCKING_LIFECYCLE_STATE).toBe(LIFECYCLE_STATES.BLOCKED);
  });

  it("allows legal forward transitions with the correct owner", () => {
    expect(
      policy.isLegalLifecycleTransition(
        LIFECYCLE_STATES.READY_FOR_AI_DEV,
        LIFECYCLE_STATES.CLAIMED,
      ),
    ).toBe(true);
    expect(
      policy.getLifecycleTransitionOwner(
        LIFECYCLE_STATES.READY_FOR_AI_DEV,
        LIFECYCLE_STATES.CLAIMED,
      ),
    ).toBe("queue-controller");

    const result = policy.applyLifecycleTransition({
      from: LIFECYCLE_STATES.READY_FOR_AI_DEV,
      to: LIFECYCLE_STATES.CLAIMED,
      actor: "queue-controller",
    });
    expect(result).toEqual({
      allowed: true,
      from: LIFECYCLE_STATES.READY_FOR_AI_DEV,
      to: LIFECYCLE_STATES.CLAIMED,
      owner: "queue-controller",
    });
  });

  it("allows the lifecycle reconciler to fail a known state closed", () => {
    expect(
      policy.isLegalLifecycleTransition(LIFECYCLE_STATES.PR_OPEN, LIFECYCLE_STATES.BLOCKED),
    ).toBe(true);
    expect(
      policy.getLifecycleTransitionOwner(LIFECYCLE_STATES.PR_OPEN, LIFECYCLE_STATES.BLOCKED),
    ).toBe("lifecycle-reconciler");
  });

  it("only allows a human operator to resume out of the blocked state", () => {
    const legal = policy.applyLifecycleTransition({
      from: LIFECYCLE_STATES.BLOCKED,
      to: LIFECYCLE_STATES.READY_FOR_AI_DEV,
      actor: "human-operator",
    });
    expect(legal.allowed).toBe(true);

    const wrongActor = policy.applyLifecycleTransition({
      from: LIFECYCLE_STATES.BLOCKED,
      to: LIFECYCLE_STATES.READY_FOR_AI_DEV,
      actor: "implementation-agent",
    });
    expect(wrongActor).toEqual({
      allowed: false,
      from: LIFECYCLE_STATES.BLOCKED,
      to: LIFECYCLE_STATES.READY_FOR_AI_DEV,
      owner: "human-operator",
      reason: "actor-not-authorized-for-transition",
    });
  });

  it("rejects illegal transitions in a fail-closed way", () => {
    expect(policy.isLegalLifecycleTransition(LIFECYCLE_STATES.DONE, LIFECYCLE_STATES.OPPORTUNITY)).toBe(
      false,
    );
    const result = policy.applyLifecycleTransition({
      from: LIFECYCLE_STATES.DONE,
      to: LIFECYCLE_STATES.OPPORTUNITY,
    });
    expect(result).toEqual({
      allowed: false,
      from: LIFECYCLE_STATES.DONE,
      to: LIFECYCLE_STATES.OPPORTUNITY,
      reason: "illegal-lifecycle-transition",
    });
  });

  it("rejects transitions involving unknown lifecycle states", () => {
    const result = policy.applyLifecycleTransition({ from: "made-up-state", to: LIFECYCLE_STATES.DONE });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("unknown-lifecycle-state");
  });

  it("keeps every transition target a known lifecycle state", () => {
    const known = new Set(Object.values(LIFECYCLE_STATES));
    for (const transition of policy.LIFECYCLE_TRANSITIONS) {
      expect(known.has(transition.to)).toBe(true);
      expect(transition.from === "*" || known.has(transition.from)).toBe(true);
      expect(typeof transition.owner).toBe("string");
      expect(transition.owner.length).toBeGreaterThan(0);
    }
  });
});
