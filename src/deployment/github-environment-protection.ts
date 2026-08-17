export const IMMUTABLE_GITHUB_REPOSITORY = {
  owner: "The-weyland-yutani-corporation",
  ownerId: 264_313_301,
  name: "project-krypto-dog",
  repositoryId: 1_189_023_287,
  fullName: "The-weyland-yutani-corporation/project-krypto-dog",
} as const;

export const PROTECTED_MUTATION_ENVIRONMENTS = [
  "platform",
  "production-deploy",
  "production-promotion",
] as const;

export const DEPLOYMENT_BRANCH_POLICIES = {
  platform: ["develop/azure", "main"],
  development: ["develop/azure"],
  "production-deploy": ["develop/azure", "main"],
  "production-promotion": ["develop/azure", "main"],
} as const;

const AUTHORIZED_REVIEWERS = new Set(["User:62218708"]);

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as JsonObject;
}

function arrayValue(
  object: JsonObject,
  field: string,
  context: string,
): unknown[] {
  const value = object[field];
  if (!Array.isArray(value)) {
    throw new Error(`${context}.${field} must be an array.`);
  }
  return value;
}

function stringValue(
  object: JsonObject,
  field: string,
  context: string,
): string {
  const value = object[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context}.${field} must be a non-empty string.`);
  }
  return value;
}

function numberValue(
  object: JsonObject,
  field: string,
  context: string,
): number {
  const value = object[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${context}.${field} must be a positive integer.`);
  }
  return value;
}

function assertBranchPolicy(environment: JsonObject, name: string): void {
  const policy = objectValue(
    environment.deployment_branch_policy,
    `${name}.deployment_branch_policy`,
  );
  if (
    policy.custom_branch_policies !== true ||
    policy.protected_branches !== false
  ) {
    throw new Error(
      `${name} must use explicit custom deployment branch policies.`,
    );
  }
  const branchRule = arrayValue(
    environment,
    "protection_rules",
    name,
  ).find(
    (rule) =>
      objectValue(rule, `${name}.protection_rules[]`).type === "branch_policy",
  );
  if (!branchRule) {
    throw new Error(`${name} is missing its branch-policy protection rule.`);
  }
}

export function assertImmutableRepositoryIdentity(payload: unknown): void {
  const repository = objectValue(payload, "repository");
  const owner = objectValue(repository.owner, "repository.owner");
  if (
    numberValue(repository, "id", "repository") !==
      IMMUTABLE_GITHUB_REPOSITORY.repositoryId ||
    stringValue(repository, "full_name", "repository") !==
      IMMUTABLE_GITHUB_REPOSITORY.fullName ||
    numberValue(owner, "id", "repository.owner") !==
      IMMUTABLE_GITHUB_REPOSITORY.ownerId ||
    stringValue(owner, "login", "repository.owner") !==
      IMMUTABLE_GITHUB_REPOSITORY.owner ||
    stringValue(owner, "type", "repository.owner") !== "Organization"
  ) {
    throw new Error(
      "GitHub repository identity does not match the immutable Project Krypto owner/repository IDs.",
    );
  }
}

export function assertDeploymentBranchPolicies(
  environmentName: keyof typeof DEPLOYMENT_BRANCH_POLICIES,
  payload: unknown,
): void {
  const response = objectValue(payload, `${environmentName}.branch-policies`);
  const policies = arrayValue(
    response,
    "branch_policies",
    `${environmentName}.branch-policies`,
  );
  const actual = policies.map((value) => {
    const policy = objectValue(
      value,
      `${environmentName}.branch-policies[]`,
    );
    if (stringValue(policy, "type", `${environmentName}.branch-policies[]`) !== "branch") {
      throw new Error(
        `${environmentName} contains a non-branch deployment policy.`,
      );
    }
    return stringValue(
      policy,
      "name",
      `${environmentName}.branch-policies[]`,
    );
  });
  const expected = [...DEPLOYMENT_BRANCH_POLICIES[environmentName]];
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    !expected.every((name) => actual.includes(name))
  ) {
    throw new Error(
      `${environmentName} deployment branch policies must be exactly: ${expected.join(", ")}.`,
    );
  }
}

export function assertProtectedMutationEnvironment(
  expectedName: (typeof PROTECTED_MUTATION_ENVIRONMENTS)[number],
  payload: unknown,
): void {
  const environment = objectValue(payload, expectedName);
  if (stringValue(environment, "name", expectedName) !== expectedName) {
    throw new Error(`${expectedName} environment name does not match.`);
  }
  assertBranchPolicy(environment, expectedName);
  if (environment.can_admins_bypass !== false) {
    throw new Error(
      `${expectedName} must set can_admins_bypass=false so administrators cannot skip the approval boundary.`,
    );
  }

  const reviewerRules = arrayValue(
    environment,
    "protection_rules",
    expectedName,
  )
    .map((rule) =>
      objectValue(rule, `${expectedName}.protection_rules[]`),
    )
    .filter((rule) => rule.type === "required_reviewers");
  if (reviewerRules.length !== 1) {
    throw new Error(
      `${expectedName} must have exactly one required-reviewers rule.`,
    );
  }

  const reviewerRule = reviewerRules[0]!;
  if (reviewerRule.prevent_self_review !== true) {
    throw new Error(
      `${expectedName} must set prevent_self_review=true so the mutation requester cannot approve their own run.`,
    );
  }

  const reviewers = arrayValue(reviewerRule, "reviewers", expectedName);
  if (reviewers.length === 0) {
    throw new Error(`${expectedName} must require an authorized human reviewer.`);
  }

  const seen = new Set<string>();
  for (const value of reviewers) {
    const entry = objectValue(value, `${expectedName}.reviewers[]`);
    const principalType = stringValue(
      entry,
      "type",
      `${expectedName}.reviewers[]`,
    );
    const reviewer = objectValue(
      entry.reviewer,
      `${expectedName}.reviewers[].reviewer`,
    );
    const reviewerObjectType = stringValue(
      reviewer,
      "type",
      `${expectedName}.reviewers[].reviewer`,
    );
    const reviewerId = numberValue(
      reviewer,
      "id",
      `${expectedName}.reviewers[].reviewer`,
    );

    if (
      principalType !== "User" ||
      reviewerObjectType !== "User"
    ) {
      throw new Error(
        `${expectedName} reviewer ${reviewerId} is a bot, application, team, or unsupported principal rather than an audited human user.`,
      );
    }

    const principal = `${principalType}:${reviewerId}`;
    if (!AUTHORIZED_REVIEWERS.has(principal)) {
      throw new Error(
        `${expectedName} reviewer ${principal} is not in the audited authority allowlist.`,
      );
    }
    if (seen.has(principal)) {
      throw new Error(`${expectedName} contains duplicate reviewer ${principal}.`);
    }
    seen.add(principal);
  }
}

export function assertDevelopmentEnvironment(payload: unknown): void {
  const name = "development";
  const environment = objectValue(payload, name);
  if (stringValue(environment, "name", name) !== name) {
    throw new Error("development environment name does not match.");
  }
  assertBranchPolicy(environment, name);
  const hasReviewerRule = arrayValue(
    environment,
    "protection_rules",
    name,
  ).some(
    (rule) =>
      objectValue(rule, `${name}.protection_rules[]`).type ===
      "required_reviewers",
  );
  if (hasReviewerRule) {
    throw new Error(
      "development must retain its documented branch/exact-SHA gate without being mistaken for a production human-approval boundary.",
    );
  }
}
