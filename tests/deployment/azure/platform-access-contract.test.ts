import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "../../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function filterAssignments(
  accountId: string,
  effective: unknown[],
  direct: unknown[],
): Array<Record<string, string>> {
  const result = spawnSync(
    "jq",
    [
      "-cn",
      "--arg",
      "account_id",
      accountId,
      "--argjson",
      "effective",
      JSON.stringify(effective),
      "--argjson",
      "direct",
      JSON.stringify(direct),
      "--from-file",
      path.join(root, "scripts/azure/filter-foundry-role-assignments.jq"),
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || "Foundry assignment filter failed");
  }
  return JSON.parse(result.stdout) as Array<Record<string, string>>;
}

describe("Azure platform workload access contract", () => {
  const workflow = read(".github/workflows/azure-platform-access.yml");
  const infraValidationWorkflow = read(
    ".github/workflows/azure-infra-validate.yml",
  );
  const template = read("infra/platform-access/main.bicep");
  const parameters = read("infra/params/platform-access.bicepparam");
  const groupVerification = read(
    "scripts/azure/verify-foundry-uami-groups.sh",
  );
  const openAiUserRoleId = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd";

  it("allowlists the reviewed accounts and binds them to the actual deployment scope", () => {
    expect(template).toMatch(
      /@allowed\(\[\s*'ghcp-foundry-eastus2'\s*'ai-krypto-westus3'\s*\]\)\s*param foundryAccountName/,
    );
    expect(template).not.toContain("param foundryResourceGroupName");
    expect(template).not.toContain("assert ");
    expect(template).toContain("output foundryResourceGroupName string = resourceGroup().name");
    expect(parameters).toContain(
      "param foundryAccountName = 'ghcp-foundry-eastus2'",
    );
    expect(infraValidationWorkflow).toContain(
      "for f in infra/*.bicep infra/platform-access/*.bicep",
    );
  });

  it("resolves only the six fixed UAMIs and accepts no principal-ID authority", () => {
    const fixedWorkloadIdentityNames = [
      "id-krypto-dev-runtime",
      "id-krypto-dev-ops",
      "id-krypto-prod-runtime",
      "id-krypto-prod-ops",
    ];
    const fixedSchedulerIdentityNames = [
      "id-krypto-dev-scheduler",
      "id-krypto-prod-scheduler",
    ];

    for (const identityName of fixedWorkloadIdentityNames) {
      expect(template).toContain(`name: '${identityName}'`);
      expect(workflow).toContain(identityName);
    }
    for (const identityName of fixedSchedulerIdentityNames) {
      expect(template).not.toContain(`name: '${identityName}'`);
      expect(workflow).toContain(identityName);
    }

    expect(template.match(/userAssignedIdentities@2024-11-30/g)).toHaveLength(4);
    expect(workflow.match(/must resolve to six distinct principals/g)).toHaveLength(
      2,
    );
    expect(parameters).not.toMatch(/PrincipalId|PRINCIPAL_ID/);
    expect(workflow).not.toMatch(/inputs\.[a-z_]*principal_id/i);
    expect(workflow).not.toMatch(/dev_runtime_principal_id:/i);
  });

  it("makes the operational target verify-only and keeps dedicated apply protected", () => {
    expect(workflow).toContain("- verify");
    expect(workflow).toContain("- apply-dedicated");
    expect(workflow).toContain(
      "Operational Foundry RBAC mutation is human-only; GitHub OIDC refuses this apply.",
    );
    expect(workflow).toContain(
      "inputs.operation == 'apply-dedicated' && inputs.foundry_account_name == 'ai-krypto-westus3' && inputs.foundry_resource_group_name == 'rg-krypto-platform'",
    );
    expect(workflow.match(/environment: platform/g)).toHaveLength(2);
    expect(workflow.indexOf("az deployment group what-if")).toBeGreaterThan(-1);
    expect(workflow.indexOf("az deployment group create")).toBeGreaterThan(
      workflow.indexOf("az deployment group what-if"),
    );
    expect(workflow).toContain('select(.changeType == "Delete")');
    expect(workflow).not.toContain(
      "Microsoft.Authorization/roleAssignments/write",
    );
    expect(workflow).toContain("reviewed_source_sha:");
    expect(
      workflow.match(
        /The workflow source must equal the exact reviewed commit SHA\./g,
      ),
    ).toHaveLength(2);
    const applyBlock = workflow.slice(workflow.indexOf("\n  apply:"));
    expect(applyBlock.indexOf("Validate reviewed workflow source")).toBeLessThan(
      applyBlock.indexOf("Azure login (OIDC)"),
    );
  });

  it("fails closed on any extra workload access and all scheduler access", () => {
    expect(
      template.match(/Microsoft\.Authorization\/roleAssignments/g),
    ).toHaveLength(4);
    expect(
      template.match(/principalType: 'ServicePrincipal'/g),
    ).toHaveLength(4);
    expect(template).toContain(openAiUserRoleId);
    expect(workflow).toContain(openAiUserRoleId);
    expect(template).not.toMatch(/schedulerOpenAiUser/i);

    expect(workflow.match(/--include-inherited/g)).toHaveLength(4);
    expect(workflow).not.toContain("--include-groups");
    expect(workflow.match(/--fill-principal-name false/g)).toHaveLength(4);
    expect(workflow.match(/%24filter=assignedTo/g)).toHaveLength(2);
    expect(
      workflow.match(
        /--from-file scripts\/azure\/filter-foundry-role-assignments\.jq/g,
      ),
    ).toHaveLength(4);
    expect(workflow.match(/\.nextLink \/\/ empty/g)).toHaveLength(2);
    expect(workflow).not.toMatch(/--scope "\$\{account_id\}"[\s\S]*?--all/);
    expect(workflow.match(/\(length == 1\) and/g)).toHaveLength(2);
    expect(workflow.match(/jq -e 'length == 0'/g)).toHaveLength(2);
    expect(
      workflow.match(/\.properties\.disableLocalAuth == true/g),
    ).toHaveLength(2);
    expect(workflow).toContain(
      "Foundry account still permits key-based local authentication; RBAC verification is not an access boundary.",
    );
    expect(workflow).toContain(
      "must have exactly one direct/effective assignment: account-scoped Cognitive Services OpenAI User.",
    );
    expect(workflow).toContain(
      "must have zero direct or inherited Foundry assignments.",
    );
    expect(workflow).not.toContain(
      "roleDefinitionName=='Cognitive Services OpenAI User'",
    );
  });

  it("requires a human Microsoft Graph proof of zero transitive group membership", () => {
    expect(groupVerification).toContain(
      'az account show --subscription "${subscription}" --query user.type',
    );
    expect(groupVerification).toContain(
      "/transitiveMemberOf/microsoft.graph.group?%24select=id",
    );
    expect(groupVerification).toContain(
      '--resource "https://graph.microsoft.com/"',
    );
    expect(groupVerification).toContain(
      "All six fixed UAMIs have zero transitive Entra group memberships.",
    );
    for (const identityName of [
      "id-krypto-dev-runtime",
      "id-krypto-dev-ops",
      "id-krypto-dev-scheduler",
      "id-krypto-prod-runtime",
      "id-krypto-prod-ops",
      "id-krypto-prod-scheduler",
    ]) {
      expect(groupVerification).toContain(identityName);
    }
    expect(groupVerification).not.toMatch(/--method\s+(post|patch|put|delete)/);
  });

  it("normalizes raw ARM child assignments so broader access cannot disappear", () => {
    const accountId =
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-foundry/providers/Microsoft.CognitiveServices/accounts/foundry";
    const principalId = "11111111-1111-1111-1111-111111111111";
    const exactAssignmentId = `${accountId}/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
    const childScope = `${accountId}/deployments/krypto-dev-luna`;
    const childAssignmentId = `${childScope}/providers/Microsoft.Authorization/roleAssignments/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;
    const exactEffective = {
      id: exactAssignmentId,
      scope: accountId,
      roleDefinitionId: `/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/${openAiUserRoleId}`,
      principalId,
      principalType: "ServicePrincipal",
    };
    const exactDirect = {
      id: exactAssignmentId,
      properties: {
        scope: accountId,
        roleDefinitionId: exactEffective.roleDefinitionId,
        principalId,
        principalType: "ServicePrincipal",
      },
    };
    const broaderChildAssignment = {
      id: childAssignmentId,
      properties: {
        scope: childScope,
        roleDefinitionId:
          "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/cccccccc-cccc-cccc-cccc-cccccccccccc",
        principalId,
        principalType: "ServicePrincipal",
      },
    };

    const workloadAssignments = filterAssignments(
      accountId,
      [exactEffective],
      [exactDirect, broaderChildAssignment],
    );
    expect(workloadAssignments).toHaveLength(2);
    expect(workloadAssignments.map(({ scope }) => scope)).toContain(childScope);

    const schedulerAssignments = filterAssignments(
      accountId,
      [],
      [broaderChildAssignment],
    );
    expect(schedulerAssignments).toHaveLength(1);
    expect(schedulerAssignments[0]?.scope).toBe(childScope);
  });
});
