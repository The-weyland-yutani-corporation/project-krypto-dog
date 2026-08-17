import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function count(source: string, literal: string): number {
  return source.split(literal).length - 1;
}

describe("protected mutation workflow authority", () => {
  it.each([
    [".github/workflows/azure-platform.yml", "platform"],
    [".github/workflows/azure-deploy-prod.yml", "production-deploy"],
    [".github/workflows/azure-deploy-prod.yml", "production-promotion"],
    [".github/workflows/azure-rotate-secrets.yml", "production-deploy"],
    [".github/workflows/azure-rotate-secrets.yml", "production-promotion"],
  ])(
    "rechecks live approval policy in every %s %s job",
    (relativePath, environment) => {
      const source = read(relativePath);
      expect(count(source, `environment: ${environment}`)).toBeGreaterThan(0);
      expect(
        count(
          source,
          `verify-github-environment-protection.sh --environment ${environment}`,
        ),
      ).toBe(count(source, `environment: ${environment}`));
    },
  );

  it("pins the live verifier to immutable repository, human, and branch identities", () => {
    const source = read(
      ".github/scripts/azure/verify-github-environment-protection.sh",
    );
    expect(source).toContain(
      'repository="The-weyland-yutani-corporation/project-krypto-dog"',
    );
    expect(source).toContain('repository_id="1189023287"');
    expect(source).toContain('owner_id="264313301"');
    expect(source).toContain('reviewer_id="62218708"');
    expect(source).toContain(".can_admins_bypass == false");
    expect(source).toContain("$rule.prevent_self_review == true");
    expect(source).toContain('$rule.reviewers[0].reviewer.type == "User"');
    expect(source).toContain('["develop/azure", "main"]');
  });

  it("revalidates fresh zero-trade activation evidence at each dev schedule mutation", () => {
    const source = read(".github/workflows/azure-deploy-dev.yml");
    const promotion = source.slice(source.indexOf("  promote-schedule:"));
    const activation = promotion.indexOf(
      "Revalidate the exact zero-trade shadow proof before schedule mutation",
    );
    const monitoring = promotion.indexOf(
      "az deployment group create \\\n            --resource-group \"${DEV_RESOURCE_GROUP_NAME}\" \\\n            --name \"monitor-dev-schedule",
    );
    const rollout = promotion.indexOf(
      "az deployment group create \\\n            --resource-group \"${DEV_RESOURCE_GROUP_NAME}\" \\\n            --name \"roll-dev-schedule",
    );

    expect(activation).toBeGreaterThan(0);
    expect(monitoring).toBeGreaterThan(activation);
    expect(rollout).toBeGreaterThan(monitoring);
    expect(
      count(promotion.slice(activation, rollout), "--operation activation-check"),
    ).toBeGreaterThanOrEqual(2);
    expect(
      promotion.slice(rollout - 500, rollout),
    ).toContain("--operation activation-check");
  });
});
