import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeMatrixEvidence,
  parseRuntimeMatrixArguments,
  serializeRuntimeMatrixEvidence,
  writeRuntimeMatrixEvidence,
  type RuntimeMatrixCommandOutputs,
} from "../../scripts/runtime-matrix-evidence";

const root = path.resolve(__dirname, "../..");
const commitSha = "a".repeat(40);
const expectedNodeVersion = "22.13.0";
const outputs: RuntimeMatrixCommandOutputs = {
  nodeVersion: "v22.13.0",
  npmVersion: "10.9.2",
  postgresServerVersion: "17.6 (Debian 17.6-1.pgdg120+1)",
  psqlVersion: "psql (PostgreSQL) 17.6 (Debian 17.6-1.pgdg120+1)",
  pgDumpVersion: "pg_dump (PostgreSQL) 17.6 (Debian 17.6-1.pgdg120+1)",
};

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("Node 22 / PostgreSQL 17 runtime matrix", () => {
  it("keeps source, local, CI, Docker, and Azure declarations aligned", () => {
    const nvmrc = read(".nvmrc").trim();
    const packageJson = JSON.parse(read("package.json")) as {
      engines: { node: string };
      scripts: Record<string, string>;
    };
    const dockerfile = read("Dockerfile");
    const compose = read("docker-compose.yml");
    const ci = read(".github/workflows/ci.yml");
    const postgresModule = read("infra/modules/postgresql.bicep");
    const localRunbook = read("specs/local-testing.md");
    const deploymentRunbook = read("specs/deployment.md");
    const readiness = read("specs/readiness.md");
    const prd = read("specs/prd.md");
    const infraReadme = read("infra/README.md");
    const readme = read("README.md");

    expect(nvmrc).toBe(expectedNodeVersion);
    expect(packageJson.engines.node).toBe(">=22.13.0 <23");
    expect(packageJson.scripts["evidence:runtime-matrix"]).toBe(
      "npx tsx scripts/runtime-matrix-evidence.ts",
    );
    expect(dockerfile).toContain(
      `ARG NODE_VERSION=${expectedNodeVersion}-bookworm-slim`,
    );
    expect(compose).toContain("image: postgres:17-alpine");
    expect(compose).not.toContain("postgres:16");
    expect(postgresModule).toContain("version: '17'");

    const setupNodeSteps = ci.match(/uses: actions\/setup-node@v4/g) ?? [];
    const nvmrcSteps = ci.match(/node-version-file: '\.nvmrc'/g) ?? [];
    expect(setupNodeSteps.length).toBeGreaterThanOrEqual(2);
    expect(nvmrcSteps).toHaveLength(setupNodeSteps.length);
    expect(ci).toContain("image: postgres:17");
    expect(ci).toContain("postgresql-client-17");
    expect(ci).not.toContain("postgres:16");
    expect(ci).not.toContain("******");
    expect(ci).toContain(
      "TEST_POSTGRES_ADMIN_URL: ${{ format('postgresql://postgres:{0}@127.0.0.1:5432/postgres', 'postgres') }}",
    );
    expect(ci).toContain(
      'npm run --silent evidence:runtime-matrix -- --out artifacts/runtime-matrix.json --commit "$GITHUB_SHA"',
    );
    expect(ci).toContain("name: runtime-matrix-${{ github.sha }}");
    expect(ci).toContain("path: artifacts/runtime-matrix.json");
    expect(ci).toContain("if: always()");
    expect(ci).toContain("if-no-files-found: error");
    expect(ci).toContain("overwrite: false");
    expect(ci).toContain("retention-days: 90");
    expect(ci.indexOf("Capture exact runtime matrix")).toBeLessThan(
      ci.indexOf("Run migration and transactional integration suite"),
    );
    expect(
      ci.indexOf("Run migration and transactional integration suite"),
    ).toBeLessThan(ci.indexOf("Upload exact runtime matrix"));

    for (const document of [
      localRunbook,
      deploymentRunbook,
      readiness,
      prd,
      infraReadme,
      readme,
    ]) {
      expect(document).toContain("Node.js 22.13.0");
      expect(document).toMatch(/PostgreSQL(?: Flexible Server)? 17/);
    }
  });

  it("serializes exact command output deterministically with the commit SHA", () => {
    const evidence = createRuntimeMatrixEvidence({
      commitSha,
      expectedNodeVersion,
      outputs,
    });

    expect(evidence).toEqual({
      schemaVersion: 1,
      commitSha,
      expectations: {
        nodeExact: "22.13.0",
        postgresqlMajor: 17,
      },
      commands: {
        "node --version": "v22.13.0",
        "npm --version": "10.9.2",
        "SHOW server_version": "17.6 (Debian 17.6-1.pgdg120+1)",
        "psql --version":
          "psql (PostgreSQL) 17.6 (Debian 17.6-1.pgdg120+1)",
        "pg_dump --version":
          "pg_dump (PostgreSQL) 17.6 (Debian 17.6-1.pgdg120+1)",
      },
    });
    const serialized = serializeRuntimeMatrixEvidence(evidence);
    expect(serialized).toBe(`${JSON.stringify(evidence, null, 2)}\n`);
    expect(serialized).not.toContain("generatedAt");
  });

  it.each([
    ["nodeVersion", "v22.12.0", /node --version must be v22\.13\.0/],
    [
      "npmVersion",
      "npm 10.9.2",
      /npm --version must return one exact semantic version/,
    ],
    [
      "postgresServerVersion",
      "16.10",
      /PostgreSQL server major must be 17/,
    ],
    ["psqlVersion", "psql (PostgreSQL) 16.10", /psql major must be 17/],
    [
      "pgDumpVersion",
      "pg_dump (PostgreSQL) 16.10",
      /pg_dump major must be 17/,
    ],
    [
      "pgDumpVersion",
      "pg_dump (PostgreSQL) 17.5",
      /psql and pg_dump must come from the same PostgreSQL client release/,
    ],
    [
      "postgresServerVersion",
      "17.6\n16.10",
      /SHOW server_version must return exactly one non-empty line/,
    ],
    [
      "postgresServerVersion",
      "17 garbage",
      /SHOW server_version returned an unrecognized PostgreSQL version/,
    ],
    [
      "postgresServerVersion",
      "17 16.10",
      /SHOW server_version returned an unrecognized PostgreSQL version/,
    ],
    [
      "postgresServerVersion",
      "017.6",
      /SHOW server_version returned an unrecognized PostgreSQL version/,
    ],
    [
      "psqlVersion",
      "psql (PostgreSQL) 17.6 garbage",
      /psql --version returned an unrecognized PostgreSQL version/,
    ],
  ] as const)(
    "fails closed when %s is %s",
    (key, value, expectedError) => {
      expect(() =>
        createRuntimeMatrixEvidence({
          commitSha,
          expectedNodeVersion,
          outputs: { ...outputs, [key]: value },
        }),
      ).toThrow(expectedError);
    },
  );

  it("rejects an unbound commit or a non-exact .nvmrc contract", () => {
    expect(() =>
      createRuntimeMatrixEvidence({
        commitSha: "abc123",
        expectedNodeVersion,
        outputs,
      }),
    ).toThrow(/Commit SHA must be exactly 40 lowercase hexadecimal/);
    expect(() =>
      createRuntimeMatrixEvidence({
        commitSha,
        expectedNodeVersion: "22",
        outputs,
      }),
    ).toThrow(/\.nvmrc must contain one exact x\.y\.z/);
  });

  it("requires explicit, single output and commit arguments", () => {
    expect(
      parseRuntimeMatrixArguments([
        "--out",
        "artifacts/runtime-matrix.json",
        "--commit",
        commitSha,
      ]),
    ).toEqual({
      out: "artifacts/runtime-matrix.json",
      commitSha,
    });
    expect(() => parseRuntimeMatrixArguments([])).toThrow(/--out is required/);
    expect(() =>
      parseRuntimeMatrixArguments(["--out", "one", "--out", "two"]),
    ).toThrow(/--out may be supplied only once/);
    expect(() =>
      parseRuntimeMatrixArguments(["--unknown", "value"]),
    ).toThrow(/Unknown runtime matrix argument/);
  });

  it("writes once and refuses to overwrite retained evidence", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "krypto-runtime-matrix-"),
    );
    const outputPath = path.join(directory, "runtime-matrix.json");
    const evidence = createRuntimeMatrixEvidence({
      commitSha,
      expectedNodeVersion,
      outputs,
    });

    try {
      await writeRuntimeMatrixEvidence(outputPath, evidence);
      expect(fs.readFileSync(outputPath, "utf8")).toBe(
        serializeRuntimeMatrixEvidence(evidence),
      );
      await expect(
        writeRuntimeMatrixEvidence(outputPath, evidence),
      ).rejects.toThrow(/Refusing to overwrite runtime matrix evidence/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
