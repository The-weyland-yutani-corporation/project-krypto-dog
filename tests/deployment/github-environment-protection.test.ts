import {
  assertDeploymentBranchPolicies,
  assertDevelopmentEnvironment,
  assertImmutableRepositoryIdentity,
  assertProtectedMutationEnvironment,
  IMMUTABLE_GITHUB_REPOSITORY,
} from "@/deployment/github-environment-protection";

const HUMAN_REVIEWER_ID = 62_218_708;

function reviewer(
  entryType = "User",
  objectType = "User",
  id = HUMAN_REVIEWER_ID,
) {
  return {
    type: entryType,
    reviewer: {
      id,
      login: "VeVarunSharma",
      type: objectType,
    },
  };
}

function environment(options: {
  name?: string;
  canAdminsBypass?: boolean;
  preventSelfReview?: boolean;
  reviewers?: unknown[];
  includeBranchRule?: boolean;
}) {
  return {
    name: options.name ?? "production-deploy",
    can_admins_bypass: options.canAdminsBypass ?? false,
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
    protection_rules: [
      ...(options.includeBranchRule === false
        ? []
        : [{ id: 1, type: "branch_policy" }]),
      {
        id: 2,
        type: "required_reviewers",
        prevent_self_review: options.preventSelfReview ?? true,
        reviewers: options.reviewers ?? [reviewer()],
      },
    ],
  };
}

describe("GitHub Environment mutation authority", () => {
  it("accepts the immutable repository and audited human reviewer boundary", () => {
    expect(() =>
      assertImmutableRepositoryIdentity({
        id: IMMUTABLE_GITHUB_REPOSITORY.repositoryId,
        full_name: IMMUTABLE_GITHUB_REPOSITORY.fullName,
        owner: {
          id: IMMUTABLE_GITHUB_REPOSITORY.ownerId,
          login: IMMUTABLE_GITHUB_REPOSITORY.owner,
          type: "Organization",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertProtectedMutationEnvironment(
        "production-deploy",
        environment({}),
      ),
    ).not.toThrow();
  });

  it("rejects self approval at the authoritative environment boundary", () => {
    expect(() =>
      assertProtectedMutationEnvironment(
        "production-deploy",
        environment({ preventSelfReview: false }),
      ),
    ).toThrow("prevent_self_review=true");
  });

  it("rejects administrator bypass of the approval boundary", () => {
    expect(() =>
      assertProtectedMutationEnvironment(
        "production-deploy",
        environment({ canAdminsBypass: true }),
      ),
    ).toThrow("can_admins_bypass=false");
  });

  it.each([
    ["bot", reviewer("User", "Bot")],
    ["application", reviewer("App", "App")],
    ["team", reviewer("Team", "Team")],
  ])("rejects a %s approval principal", (_kind, principal) => {
    expect(() =>
      assertProtectedMutationEnvironment(
        "production-deploy",
        environment({ reviewers: [principal] }),
      ),
    ).toThrow("rather than an audited human user");
  });

  it("rejects an unapproved human identity", () => {
    expect(() =>
      assertProtectedMutationEnvironment(
        "production-deploy",
        environment({ reviewers: [reviewer("User", "User", 123)] }),
      ),
    ).toThrow("not in the audited authority allowlist");
  });

  it("rejects missing reviewer and branch protections", () => {
    expect(() =>
      assertProtectedMutationEnvironment(
        "production-deploy",
        environment({ reviewers: [] }),
      ),
    ).toThrow("authorized human reviewer");
    expect(() =>
      assertProtectedMutationEnvironment(
        "production-deploy",
        environment({ includeBranchRule: false }),
      ),
    ).toThrow("missing its branch-policy");
  });

  it("rejects mutable or pre-transfer repository identity", () => {
    expect(() =>
      assertImmutableRepositoryIdentity({
        id: IMMUTABLE_GITHUB_REPOSITORY.repositoryId,
        full_name: "VeVarunSharma/project-krypto-dog",
        owner: {
          id: 62_218_708,
          login: "VeVarunSharma",
          type: "User",
        },
      }),
    ).toThrow("immutable Project Krypto owner/repository IDs");
  });

  it("accepts only the exact audited deployment branch set", () => {
    expect(() =>
      assertDeploymentBranchPolicies("production-deploy", {
        branch_policies: [
          { name: "main", type: "branch" },
          { name: "develop/azure", type: "branch" },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertDeploymentBranchPolicies("production-deploy", {
        branch_policies: [
          { name: "main", type: "branch" },
          { name: "develop/azure", type: "branch" },
          { name: "feature/**", type: "branch" },
        ],
      }),
    ).toThrow("must be exactly");
    expect(() =>
      assertDeploymentBranchPolicies("development", {
        branch_policies: [
          { name: "develop/azure", type: "branch" },
          { name: "develop/azure", type: "branch" },
        ],
      }),
    ).toThrow("must be exactly");
  });

  it("keeps development branch-protected without claiming human approval", () => {
    const development = environment({
      name: "development",
      reviewers: [],
    });
    development.protection_rules = development.protection_rules.filter(
      (rule) => rule.type !== "required_reviewers",
    );

    expect(() => assertDevelopmentEnvironment(development)).not.toThrow();
    expect(() =>
      assertDevelopmentEnvironment(
        environment({
          name: "development",
        }),
      ),
    ).toThrow("without being mistaken for a production human-approval boundary");
  });
});
