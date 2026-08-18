import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const repository = "The-weyland-yutani-corporation/project-krypto-dog";
const owner = "The-weyland-yutani-corporation";
const ownerId = "264313301";
const repositoryId = "1189023287";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function stringParam(source: string, name: string): string {
  const match = source.match(new RegExp(`^param ${name} = '([^']+)'$`, "m"));
  if (!match) throw new Error(`Missing string parameter ${name}.`);
  return match[1];
}

describe("transferred repository identity", () => {
  it("derives all four Azure OIDC subjects from immutable repository identity", () => {
    const params = read("infra/params/bootstrap.bicepparam");
    const bootstrap = read("infra/bootstrap.bicep");
    const identityModule = read("infra/modules/oidc-identity.bicep");

    expect(stringParam(params, "githubOrg")).toBe(owner);
    expect(stringParam(params, "githubOwnerId")).toBe(ownerId);
    expect(stringParam(params, "githubRepo")).toBe("project-krypto-dog");
    expect(stringParam(params, "githubRepoId")).toBe(repositoryId);

    const environments = [
      ["devGithubEnvironmentName", "development"],
      ["prodDeployGithubEnvironmentName", "production-deploy"],
      ["prodPromotionGithubEnvironmentName", "production-promotion"],
      ["platformGithubEnvironmentName", "platform"],
    ] as const;
    const subjects = environments.map(([parameter, expectedEnvironment]) => {
      const environment = stringParam(params, parameter);
      expect(environment).toBe(expectedEnvironment);
      expect(bootstrap).toContain(
        `githubEnvironmentName: ${parameter}`,
      );
      return `repo:${owner}@${ownerId}/project-krypto-dog@${repositoryId}:environment:${environment}`;
    });

    expect(subjects).toEqual([
      "repo:The-weyland-yutani-corporation@264313301/project-krypto-dog@1189023287:environment:development",
      "repo:The-weyland-yutani-corporation@264313301/project-krypto-dog@1189023287:environment:production-deploy",
      "repo:The-weyland-yutani-corporation@264313301/project-krypto-dog@1189023287:environment:production-promotion",
      "repo:The-weyland-yutani-corporation@264313301/project-krypto-dog@1189023287:environment:platform",
    ]);
    expect(identityModule).toContain(
      "subject: 'repo:${githubOrg}@${githubOwnerId}/${githubRepo}@${githubRepoId}:environment:${githubEnvironmentName}'",
    );
    for (const parameter of [
      "githubOrg",
      "githubOwnerId",
      "githubRepo",
      "githubRepoId",
    ]) {
      expect(
        bootstrap.match(new RegExp(`${parameter}: ${parameter}`, "g")),
      ).toHaveLength(4);
    }
  });

  it("pins package, issue-help, and workflow guard links to the new owner", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      repository: { url: string };
      bugs: { url: string };
      homepage: string;
    };
    expect(packageJson.repository.url).toBe(
      `git+https://github.com/${repository}.git`,
    );
    expect(packageJson.bugs.url).toBe(
      `https://github.com/${repository}/issues`,
    );
    expect(packageJson.homepage).toBe(
      `https://github.com/${repository}#readme`,
    );
    expect(read(".github/ISSUE_TEMPLATE/config.yml")).toContain(
      `https://github.com/${repository}/blob/main/docs/agentic-software-factory.md`,
    );
    expect(read(".github/workflows/agentic-sdlc-e2e.yml")).toContain(
      `if: github.repository == '${repository}'`,
    );
  });

  it("updates retained action and issue links without relying on redirects", () => {
    const linkedFiles = [
      "README.md",
      "docs/e2e/factory-heartbeat.md",
      "infra/README.md",
      "specs/architecture.md",
      "specs/deployment.md",
      "specs/production-readiness-prd.v1.md",
    ];
    for (const relativePath of linkedFiles) {
      const source = read(relativePath);
      expect(source).not.toContain(
        "github.com/VeVarunSharma/project-krypto-dog",
      );
    }

    expect(read("README.md")).toContain(
      `https://github.com/${repository}/actions/runs/31839812884`,
    );
    expect(read("specs/production-readiness-prd.v1.md")).toContain(
      `https://github.com/${repository}/issues/131`,
    );
  });

  it("documents active hosted execution and environment approval boundaries", () => {
    const controlDocs = [
      "README.md",
      "infra/README.md",
      "specs/architecture.md",
      "specs/deployment.md",
      "specs/readiness.md",
      "specs/prd.md",
    ];
    const staleStatements =
      /required[- ]reviewer.*(?:unavailable|unsupported)|reviewer enforcement (?:is )?unavailable|manual\/paused|GitHub-hosted (?:jobs|Actions).*(?:blocked|cannot start)|Actions billing/i;

    for (const relativePath of controlDocs) {
      const source = read(relativePath);
      expect(source).toContain("Enterprise-hosted");
      expect(source).toContain("CI_RUNNER_LABEL");
      expect(source).toContain("prevent_self_review=true");
      expect(source).not.toContain("prevent_self_review=false");
      expect(source).toMatch(
        /development[\s\S]{0,120}no\s+(?:required\s+)?reviewer/i,
      );
      expect(source).toMatch(/runner[\s\S]{0,100}retired/i);
      expect(source).toMatch(/exact[\s\S]{0,24}SHA/i);
      expect(source).not.toMatch(staleStatements);
    }

    expect(read("README.md")).toContain(
      `https://github.com/${repository}/actions/runs/31981510383`,
    );
    const deployment = read("specs/deployment.md");
    expect(deployment).toContain(
      "| `platform` | Required reviewer `@VeVarunSharma`; `prevent_self_review=true` |",
    );
    expect(deployment).toContain(
      "| `development` | No required reviewer (intentional); branch/exact-SHA/CI gates remain |",
    );
    expect(deployment).toContain(
      "| `production-deploy` | Required reviewer `@VeVarunSharma`; `prevent_self_review=true` |",
    );
    expect(deployment).toContain(
      "| `production-promotion` | Required reviewer `@VeVarunSharma`; `prevent_self_review=true`; forced-disable boundary only |",
    );
  });
});
