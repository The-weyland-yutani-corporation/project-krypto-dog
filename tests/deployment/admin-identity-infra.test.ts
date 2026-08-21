import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Azure admin identity deployment contract", () => {
  it("declares Container Apps Entra auth with exact validation and platform sessions", () => {
    const moduleSource = read("infra/modules/container-app-web.bicep");
    expect(moduleSource).toContain(
      "Microsoft.App/containerApps/authConfigs@2025-01-01",
    );
    expect(moduleSource).toContain("openIdIssuer: adminEntraIssuer");
    expect(moduleSource).toContain("allowedAudiences");
    expect(moduleSource).toContain("allowedPrincipals");
    expect(moduleSource).toContain("clientSecretSettingName");
    expect(moduleSource).toContain("validateNonce: true");
    expect(moduleSource).toContain("convention: 'FixedTime'");
    expect(moduleSource).toContain("timeToExpiration: '08:00:00'");
    expect(moduleSource).toContain("tokenRefreshExtensionHours: 8");
    expect(moduleSource).toContain("requireHttps: true");
    expect(moduleSource).toContain("'prompt=login'");
    expect(moduleSource).toContain(
      "'claims={\"id_token\":{\"acrs\":{\"essential\":true,\"value\":\"${validatedAdminEntraStepUpAuthContext}\"}}}'",
    );
  });

  it("keeps the Entra client secret out of application and ops environments", () => {
    const moduleSource = read("infra/modules/container-app-web.bicep");
    const release = read("infra/release.bicep");
    expect(moduleSource).toContain(
      "param adminEntraClientSecretKeyVaultUrl string",
    );
    expect(moduleSource).toContain(
      "keyVaultUrl: adminEntraClientSecretKeyVaultUrl",
    );
    expect(moduleSource).not.toContain(
      "{ name: 'ADMIN_ENTRA_CLIENT_SECRET'",
    );
    expect(release).toContain("name: 'admin-entra-client-secret'");
    expect(release).not.toContain("ADMIN_PASSWORD");
    expect(release).not.toContain("ADMIN_SESSION_SECRET");
    expect(release).not.toContain(
      "{ name: 'ADMIN_ENTRA_CLIENT_SECRET'",
    );
  });

  it("preserves reviewed identity inputs through release and rollout workflows", () => {
    const release = read("infra/release.bicep");
    const rollout = read("infra/rollout.bicep");
    for (const source of [release, rollout]) {
      expect(source).toContain("ADMIN_IDENTITY_MODE");
      expect(source).toContain("ADMIN_PLATFORM_AUTH");
      expect(source).toContain("ADMIN_ENTRA_OPERATOR_ALLOWLIST");
      expect(source).toContain("ADMIN_ENTRA_MFA_AUTH_CONTEXT");
      expect(source).toContain("ADMIN_ENTRA_STEP_UP_AUTH_CONTEXT");
      expect(source).toContain("ADMIN_AUTH_NOT_BEFORE");
      expect(source).toContain("ADMIN_AUTH_POLICY_VERSION");
    }
    for (const workflow of [
      ".github/workflows/azure-deploy-dev.yml",
      ".github/workflows/azure-deploy-prod.yml",
      ".github/workflows/azure-rotate-secrets.yml",
    ]) {
      const source = read(workflow);
      expect(source).toContain("ADMIN_ENTRA_OPERATOR_ALLOWLIST");
      expect(source).toContain("ADMIN_ENTRA_CLIENT_SECRET");
      expect(source).not.toContain("ADMIN_SESSION_SECRET");
      expect(source).not.toContain("ADMIN_PASSWORD:");
    }
  });
});
