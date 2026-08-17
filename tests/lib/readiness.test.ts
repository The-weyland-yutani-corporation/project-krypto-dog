import { evaluateReadiness } from "@/lib/readiness";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockDatabaseClient } from "../setup";

const releaseEnv = {
  NODE_ENV: "production",
  ROLLOUT_MODE: "paper",
  RELEASE_SHA: "a".repeat(40),
  IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  EXECUTION_CONTRACT_VERSION: "bounded-sync-v1",
  DATABASE_POOL_MAX: "1",
  AGENT_RUN_ADMISSION_CAPACITY: "1",
  COINBASE_DAILY_REQUEST_BUDGET: "1000",
  FOUNDRY_DAILY_REQUEST_BUDGET: "200",
  POSTHOG_DAILY_REQUEST_BUDGET: "2000",
  ACS_DAILY_REQUEST_BUDGET: "100",
  AZURE_FOUNDRY_AGENT_NAME: "krypto-decision",
  AZURE_FOUNDRY_AGENT_VERSION: "1",
  SAFETY_PRIMARY_ON_CALL: "primary-person",
  SAFETY_BACKUP_ON_CALL: "backup-person",
  SAFETY_RELEASE_OWNER: "release-person",
  SAFETY_APPROVER: "safety-person",
  SAFETY_EVIDENCE_CUSTODIAN: "evidence-person",
  SAFETY_ROLLBACK_OWNER: "rollback-person",
  SAFETY_PRIMARY_ON_CALL_PUBLIC_KEY:
    "MCowBQYDK2VwAyEAMYr+QdbCWfcOMw+PdmzscsQ8kz0Lj2971UsepJUKBHQ=",
  SAFETY_BACKUP_ON_CALL_PUBLIC_KEY:
    "MCowBQYDK2VwAyEAV6RES8Ay1mqt3tnuy4X2Hk7nLyFPOifxrTBPQdTezTc=",
  SAFETY_RELEASE_OWNER_PUBLIC_KEY:
    "MCowBQYDK2VwAyEAHk9XQx5sgdMfpZSQzVqXmi9rrGIEKti/mAmH1wOSz4A=",
  SAFETY_APPROVER_PUBLIC_KEY:
    "MCowBQYDK2VwAyEA+OUIMyWinxklx+I4rcL87f5ERhSbOXEiP5yXAIWsJSQ=",
  SAFETY_EVIDENCE_CUSTODIAN_PUBLIC_KEY:
    "MCowBQYDK2VwAyEA2y49i6qRTwYBc3MPPe4xysRRebKazJvitWZ5YjNFbsM=",
  SAFETY_ROLLBACK_OWNER_PUBLIC_KEY:
    "MCowBQYDK2VwAyEAdCuTCawJgJ0UibJWyN7eRnyy9mf8Fxv7D4d2MX+R+5I=",
};

describe("readiness contract", () => {
  it("proves all checks with one injected read-only database result", async () => {
    const query = jest.fn().mockResolvedValue({
      runtimeMember: true,
      runtimeGroupNoLogin: true,
      separateRuntimeLogin: true,
      elevatedMember: false,
      safeRole: true,
      loginRole: true,
      inheritedRole: true,
      stableIdentity: true,
      boundedConnectionLimit: true,
      postgres17: true,
      ledgerDenied: true,
      runtimeContractReadable: true,
      schemaFingerprint: "0010_safety_incidents_v1",
      contractVersion: 2,
      singletonCount: 1,
      reconciledCount: 1,
      leaseSaneCount: 1,
      unresolvedCriticalIncidentCount: 0,
    });
    const result = await evaluateReadiness({
      query,
      env: releaseEnv,
      admission: () => ({ active: 0, capacity: 2, available: 2 }),
    });
    expect(result.ready).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("fails closed without making a provider call or mutation fallback", async () => {
    const query = jest.fn().mockRejectedValue(new Error("database down"));
    const result = await evaluateReadiness({
      query,
      env: releaseEnv,
      admission: () => ({ active: 0, capacity: 2, available: 2 }),
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("database-connectivity");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns opaque reason codes for configuration drift", async () => {
    const result = await evaluateReadiness({
      query: jest.fn().mockResolvedValue(undefined),
      env: { ...releaseEnv, DATABASE_POOL_MAX: "2" },
      admission: () => ({ active: 0, capacity: 1, available: 1 }),
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("runtime-configuration");
    expect(JSON.stringify(result)).not.toContain("DATABASE_POOL_MAX");
  });

  it("blocks shadow or paper readiness for an incomplete roster", async () => {
      const result = await evaluateReadiness({
        query: jest.fn().mockResolvedValue({
          runtimeMember: true,
          runtimeGroupNoLogin: true,
          separateRuntimeLogin: true,
          elevatedMember: false,
          safeRole: true,
          loginRole: true,
          inheritedRole: true,
          stableIdentity: true,
          boundedConnectionLimit: true,
          postgres17: true,
          ledgerDenied: true,
          runtimeContractReadable: true,
          schemaFingerprint: "0010_safety_incidents_v1",
          contractVersion: 2,
          singletonCount: 1,
          reconciledCount: 1,
          leaseSaneCount: 1,
          unresolvedCriticalIncidentCount: 0,
        }),
        env: { ...releaseEnv, SAFETY_BACKUP_ON_CALL: undefined },
        admission: () => ({ active: 0, capacity: 1, available: 1 }),
      });
      expect(result.ready).toBe(false);
      expect(result.reasons).toContain("safety-roster");
  });

  it("blocks readiness while durable critical evidence is unresolved", async () => {
      const query = jest.fn().mockResolvedValue({
        runtimeMember: true,
        runtimeGroupNoLogin: true,
        separateRuntimeLogin: true,
        elevatedMember: false,
        safeRole: true,
        loginRole: true,
        inheritedRole: true,
        stableIdentity: true,
        boundedConnectionLimit: true,
        postgres17: true,
        ledgerDenied: true,
        runtimeContractReadable: true,
        schemaFingerprint: "0010_safety_incidents_v1",
        contractVersion: 2,
        singletonCount: 1,
        reconciledCount: 1,
        leaseSaneCount: 1,
        unresolvedCriticalIncidentCount: 1,
      });
      const result = await evaluateReadiness({
        query,
        env: releaseEnv,
        admission: () => ({ active: 0, capacity: 1, available: 1 }),
      });
      expect(result.ready).toBe(false);
      expect(result.reasons).toContain("safety-incidents");
  });

  it("rejects an oversized provider ceiling and direct group-role login", async () => {
    const result = await evaluateReadiness({
      query: jest.fn().mockResolvedValue({
        runtimeMember: true,
        runtimeGroupNoLogin: false,
        separateRuntimeLogin: false,
        elevatedMember: false,
        safeRole: true,
        loginRole: true,
        inheritedRole: true,
        stableIdentity: true,
        boundedConnectionLimit: true,
        postgres17: true,
        ledgerDenied: true,
        runtimeContractReadable: true,
        schemaFingerprint: "0010_safety_incidents_v1",
        contractVersion: 2,
        singletonCount: 1,
        reconciledCount: 1,
        leaseSaneCount: 1,
      }),
      env: { ...releaseEnv, FOUNDRY_DAILY_REQUEST_BUDGET: "201" },
      admission: () => ({ active: 0, capacity: 1, available: 1 }),
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "runtime-configuration",
        "runtime-identity",
      ]),
    );
  });

  it("cancels a readiness query that exceeds its bound", async () => {
    const pending = new Promise<never>(() => undefined) as Promise<never> & {
      cancel: jest.Mock;
    };
    pending.cancel = jest.fn();
    mockDatabaseClient.unsafe.mockReturnValueOnce(pending as never);
    const result = await evaluateReadiness({
      env: releaseEnv,
      timeoutMs: 1,
      admission: () => ({ active: 0, capacity: 1, available: 1 }),
    });
    expect(result.reasons).toContain("database-connectivity");
    expect(pending.cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the readiness implementation read-only and provider-free", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/readiness.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CALL)\b/);
    expect(source).not.toMatch(/coinbase\.com|EmailClient|PostHog|buildLLM/);
    expect(source).not.toMatch(/DIRECT_URL|MIGRATION_URL/);
  });
});
