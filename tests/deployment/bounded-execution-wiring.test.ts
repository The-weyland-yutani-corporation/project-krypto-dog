import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function moduleBlock(source: string, name: string, nextName?: string): string {
  const start = source.indexOf(`module ${name} `);
  const end = nextName
    ? source.indexOf(`module ${nextName} `, start + 1)
    : source.length;
  if (start < 0 || end < 0) {
    throw new Error(`Could not isolate Bicep module ${name}.`);
  }
  return source.slice(start, end);
}

describe("bounded execution deployment wiring", () => {
  const release = read("infra/release.bicep");
  const rollout = read("infra/rollout.bicep");

  it.each([
    ["release", release],
    ["rollout", rollout],
  ])(
    "pins scheduler retry, timeout, runtime capacity, and provenance in %s",
    (_name, template) => {
      expect(template).toContain("replicaRetryLimit: 0");
      expect(template).not.toContain("replicaRetryLimit: 1");
      expect(
        template.match(/replicaTimeoutSeconds: 270/g),
      ).toHaveLength(2);
      for (const entry of [
        "{ name: 'RELEASE_SHA', value: releaseSha }",
        "{ name: 'IMAGE_DIGEST', value: imageDigest }",
        "{ name: 'EXECUTION_CONTRACT_VERSION', value: 'bounded-sync-v1' }",
        "{ name: 'DATABASE_POOL_MAX', value: '1' }",
        "{ name: 'AGENT_RUN_ADMISSION_CAPACITY', value: '1' }",
      ]) {
        expect(template).toContain(entry);
      }
    },
  );

  it("leaves long-running manual ops timeouts outside the trading chain", () => {
    expect(
      moduleBlock(release, "migrateInitJob", "preflightJob"),
    ).toContain("replicaTimeoutSeconds: 900");
    expect(
      moduleBlock(release, "verifiedBackupJob", "targetSmokeJob"),
    ).toContain("replicaTimeoutSeconds: 3600");
  });

  it("pins bounded probes, HTTP concurrency, and three web replicas", () => {
    const web = read("infra/modules/container-app-web.bicep");
    expect(web).toContain("param maxReplicas int = 3");
    expect(web).toContain("concurrentRequests: '1'");
    expect(web.match(/timeoutSeconds: 5/g)).toHaveLength(2);
  });

  it("pins runtime PostgreSQL timeouts and pool capacity", () => {
    const database = read("src/db/index.ts");
    expect(database).toContain("DB_CONNECT_TIMEOUT_SECONDS = 5");
    expect(database).toContain("DB_STATEMENT_TIMEOUT_MS = 10_000");
    expect(database).toContain("DB_LOCK_TIMEOUT_MS = 2_000");
    expect(database).toContain(
      "DB_IDLE_TRANSACTION_TIMEOUT_MS = 15_000",
    );
    expect(database).toContain(
      'env.NODE_ENV === "production" && poolMax !== 1',
    );
  });

  it("renders the immutable release SHA into every rollout deployment", () => {
    const devRolloutBlocks = read(
      ".github/workflows/azure-deploy-dev.yml",
    )
      .split("--template infra/params/rollout.dev.bicepparam")
      .slice(1);
    expect(devRolloutBlocks).toHaveLength(3);
    for (const block of devRolloutBlocks) {
      expect(block).toContain(
        "--set REPLACE_WITH_REAL_COMMIT_SHA000000000000=",
      );
    }
    for (const workflow of [
      ".github/workflows/azure-deploy-prod.yml",
      ".github/workflows/azure-rotate-secrets.yml",
    ]) {
      expect(read(workflow)).toContain(
        "--set REPLACE_WITH_REAL_COMMIT_SHA000000000000=",
      );
    }
  });
});
