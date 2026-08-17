import {
  assertDeploymentBranchPolicies,
  assertDevelopmentEnvironment,
  assertImmutableRepositoryIdentity,
  assertProtectedMutationEnvironment,
  IMMUTABLE_GITHUB_REPOSITORY,
  PROTECTED_MUTATION_ENVIRONMENTS,
} from "@/deployment/github-environment-protection";

const API_ROOT = "https://api.github.com";

async function fetchJson(path: string, token: string): Promise<unknown> {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API request ${path} failed with HTTP ${response.status}.`,
    );
  }
  return response.json() as Promise<unknown>;
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GH_TOKEN or GITHUB_TOKEN is required to verify GitHub Environment protection.",
    );
  }

  const repositoryPath = `/repos/${IMMUTABLE_GITHUB_REPOSITORY.fullName}`;
  const repository = await fetchJson(repositoryPath, token);
  assertImmutableRepositoryIdentity(repository);

  const environmentNames = [
    ...PROTECTED_MUTATION_ENVIRONMENTS,
    "development",
  ] as const;
  const environments = await Promise.all(
    environmentNames.map(async (name) => [
      name,
      await fetchJson(`${repositoryPath}/environments/${name}`, token),
      await fetchJson(
        `${repositoryPath}/environments/${name}/deployment-branch-policies`,
        token,
      ),
    ] as const),
  );
  for (const [name, environment, branchPolicies] of environments) {
    assertDeploymentBranchPolicies(name, branchPolicies);
    if (name === "development") {
      assertDevelopmentEnvironment(environment);
    } else {
      assertProtectedMutationEnvironment(name, environment);
    }
  }

  console.log(
    `Verified immutable repository identity and fail-closed approval policy for ${PROTECTED_MUTATION_ENVIRONMENTS.join(", ")}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
