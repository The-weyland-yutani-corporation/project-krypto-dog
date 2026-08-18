import {
  MANIFEST_VERSION,
  assertHarnessRollout,
  assertHarnessCanStart,
  assertManifestHasNoSecrets,
  assertManifestOwnership,
  assertNotProduction,
  assertSmokeAllowed,
  assertValidPort,
  buildArtifacts,
  buildComposeDownArgs,
  buildComposeLifecycleEnv,
  buildComposePsArgs,
  buildComposeUpArgs,
  buildDatabaseUrl,
  buildManifest,
  buildPgIsReadyArgs,
  buildSmokeEnv,
  buildSpawnEnv,
  buildUpEnv,
  deriveDatabaseName,
  deriveHarnessDir,
  deriveProjectName,
  deriveWorktreeId,
  findFreePorts,
  isProductionLikeDbUrl,
  markManifestStopped,
  parseManifest,
  parseSmokeOptions,
  parseUpOptions,
  sanitizeBaseEnv,
  serializeManifest,
  verifyPidOwnership,
  type EphemeralServerLike,
} from "../../scripts/agent-harness";

const WORKTREE = "/Users/dev/code/project-krypto/worktrees/feature-a";
const OTHER_WORKTREE = "/Users/dev/code/project-krypto/worktrees/feature-b";

function baseManifestInput() {
  const id = deriveWorktreeId(WORKTREE);
  return {
    id,
    worktreePath: WORKTREE,
    projectName: deriveProjectName(id),
    databaseName: deriveDatabaseName(id),
    mode: "mock" as const,
    rollout: "disabled" as const,
    scenario: null,
    decision: null,
    ports: { app: 3000, db: 5433 },
    pid: 4242,
    startedAt: "2026-08-10T00:00:00.000Z",
    artifacts: buildArtifacts(deriveHarnessDir(WORKTREE, id)),
  };
}

// ---------------------------------------------------------------------------
// Identifiers + two-worktree noncollision
// ---------------------------------------------------------------------------

describe("harness identifiers", () => {
  it("derives a stable, sanitized worktree id", () => {
    const id = deriveWorktreeId(WORKTREE);
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(id).toMatch(/-[0-9a-f]{8}$/);
    // Stable for the same canonical path.
    expect(deriveWorktreeId(WORKTREE)).toBe(id);
    // Trailing slashes are normalized away.
    expect(deriveWorktreeId(`${WORKTREE}/`)).toBe(id);
  });

  it("produces a Postgres-safe database name", () => {
    const name = deriveDatabaseName(deriveWorktreeId(WORKTREE));
    expect(name).toMatch(/^krypto_[a-z0-9_]+$/);
    expect(name).not.toContain("-");
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("produces a Compose-safe project name", () => {
    const project = deriveProjectName(deriveWorktreeId(WORKTREE));
    expect(project).toMatch(/^krypto-harness-[a-z0-9-]+$/);
  });

  it("keeps two worktrees with the same basename from colliding", () => {
    const a = "/a/b/shared";
    const b = "/x/y/shared";
    expect(deriveWorktreeId(a)).not.toBe(deriveWorktreeId(b));
    expect(deriveProjectName(deriveWorktreeId(a))).not.toBe(
      deriveProjectName(deriveWorktreeId(b)),
    );
    expect(deriveDatabaseName(deriveWorktreeId(a))).not.toBe(
      deriveDatabaseName(deriveWorktreeId(b)),
    );
  });
});

// ---------------------------------------------------------------------------
// Free ports + validation
// ---------------------------------------------------------------------------

function fakeServerFactory(start = 40000): () => EphemeralServerLike {
  let next = start;
  return () => {
    const port = next;
    next += 1;
    return {
      once() {},
      listen(_port: number, _host: string, callback: () => void) {
        callback();
      },
      address() {
        return { port };
      },
      close(callback?: () => void) {
        if (callback) callback();
      },
    };
  };
}

describe("free-port allocation", () => {
  it("allocates the requested number of distinct ports", async () => {
    const ports = await findFreePorts(2, {
      createServer: fakeServerFactory(),
    });
    expect(ports).toHaveLength(2);
    expect(new Set(ports).size).toBe(2);
  });

  it("rejects a non-positive port count", async () => {
    await expect(
      findFreePorts(0, { createServer: fakeServerFactory() }),
    ).rejects.toThrow(/positive integer/);
  });

  it("validates TCP port ranges", () => {
    expect(() => assertValidPort(0)).toThrow(/Invalid TCP port/);
    expect(() => assertValidPort(70000)).toThrow(/Invalid TCP port/);
    expect(() => assertValidPort(3000)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Option parsing / validation
// ---------------------------------------------------------------------------

describe("up option parsing", () => {
  it("defaults to disabled mock mode", () => {
    expect(parseUpOptions([])).toEqual({
      shadow: false,
      scenario: null,
      decision: null,
    });
  });

  it("fills scenario/decision defaults under --shadow", () => {
    expect(parseUpOptions(["--shadow"])).toEqual({
      shadow: true,
      scenario: "steady",
      decision: "HOLD",
    });
  });

  it("accepts explicit shadow scenario/decision", () => {
    expect(
      parseUpOptions(["--shadow", "--scenario", "dip", "--decision", "BUY"]),
    ).toEqual({ shadow: true, scenario: "dip", decision: "BUY" });
  });

  it("treats --rollout shadow as shadow", () => {
    expect(parseUpOptions(["--rollout", "shadow"]).shadow).toBe(true);
  });

  it.each(["paper", "live", "production"])(
    "rejects forbidden rollout %s",
    (mode) => {
      expect(() => parseUpOptions(["--rollout", mode])).toThrow(
        /forbidden|Unknown rollout/,
      );
    },
  );

  it("requires --shadow before scenario/decision", () => {
    expect(() => parseUpOptions(["--scenario", "dip"])).toThrow(
      /require --shadow/,
    );
    expect(() => parseUpOptions(["--decision", "SELL"])).toThrow(
      /require --shadow/,
    );
  });

  it("rejects unknown scenario/decision values and flags", () => {
    expect(() => parseUpOptions(["--shadow", "--scenario", "boom"])).toThrow(
      /--scenario must be/,
    );
    expect(() => parseUpOptions(["--shadow", "--decision", "MAYBE"])).toThrow(
      /--decision must be/,
    );
    expect(() => parseUpOptions(["--nope"])).toThrow(/Unknown argument/);
  });

  it("parses the smoke opt-in flag", () => {
    expect(parseSmokeOptions([])).toEqual({ allowNetworkSmoke: false });
    expect(parseSmokeOptions(["--allow-network-smoke"])).toEqual({
      allowNetworkSmoke: true,
    });
    expect(() => parseSmokeOptions(["--other"])).toThrow(/Unknown argument/);
  });
});

// ---------------------------------------------------------------------------
// Environment construction
// ---------------------------------------------------------------------------

describe("mock/shadow environment construction", () => {
  const ports = { app: 3210, db: 54329 };
  const databaseName = "krypto_feature_a";

  it("builds a disabled mock environment with no external credentials", () => {
    const env = buildUpEnv({
      shadow: false,
      scenario: null,
      decision: null,
      ports,
      databaseName,
    });
    expect(env.NODE_ENV).toBe("development");
    expect(env.AGENT_HARNESS_MODE).toBe("mock");
    expect(env.ROLLOUT_MODE).toBe("disabled");
    expect(env.PORT).toBe("3210");
    expect(env.DATABASE_URL).toContain(":54329/krypto_feature_a");
    expect(env.DIRECT_URL).toBe(env.DATABASE_URL);
    expect(env.KRYPTO_DB_HOST_PORT).toBe("54329");
    expect(env.AZURE_OPENAI_BASE_URL).toBe(
      "https://stub.openai.azure.com/openai/v1",
    );
    expect(env.AZURE_OPENAI_DEPLOYMENT_NAME).toBe("krypto-harness-stub");
    for (const key of [
      "ANTHROPIC_FOUNDRY_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "AZURE_CLIENT_ID",
      "POSTHOG_API_KEY",
      "RESEND_API_KEY",
      "ALERT_EMAIL_TO",
      "AGENT_HARNESS_SCENARIO",
      "AGENT_HARNESS_DECISION",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("builds a shadow environment with deterministic scenario/decision", () => {
    const env = buildUpEnv({
      shadow: true,
      scenario: "crash",
      decision: "SELL",
      ports,
      databaseName,
    });
    expect(env.ROLLOUT_MODE).toBe("shadow");
    expect(env.AGENT_HARNESS_MODE).toBe("mock");
    expect(env.AGENT_HARNESS_SCENARIO).toBe("crash");
    expect(env.AGENT_HARNESS_DECISION).toBe("SELL");
  });

  it("strips inherited secrets when sanitizing a base environment", () => {
    const sanitized = sanitizeBaseEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      ANTHROPIC_FOUNDRY_API_KEY: "real-key",
      AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
      AZURE_CLIENT_SECRET: "real-secret",
      POSTHOG_API_KEY: "phc_real",
      DATABASE_URL: "postgresql://prod/db",
      ROLLOUT_MODE: "paper",
      CRON_SECRET: "real-cron",
    });
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.HOME).toBe("/home/dev");
    expect(sanitized.ANTHROPIC_FOUNDRY_API_KEY).toBeUndefined();
    expect(sanitized.AZURE_CLIENT_ID).toBeUndefined();
    expect(sanitized.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(sanitized.POSTHOG_API_KEY).toBeUndefined();
    expect(sanitized.DATABASE_URL).toBeUndefined();
    expect(sanitized.ROLLOUT_MODE).toBeUndefined();
    expect(sanitized.CRON_SECRET).toBeUndefined();
  });

  it("merges the harness env over a sanitized base for spawning", () => {
    const harnessEnv = buildUpEnv({
      shadow: false,
      scenario: null,
      decision: null,
      ports,
      databaseName,
    });
    const spawnEnv = buildSpawnEnv(harnessEnv, {
      PATH: "/usr/bin",
      ANTHROPIC_FOUNDRY_API_KEY: "real-key",
    });
    expect(spawnEnv.PATH).toBe("/usr/bin");
    expect(spawnEnv.ANTHROPIC_FOUNDRY_API_KEY).toBeUndefined();
    expect(spawnEnv.AGENT_HARNESS_MODE).toBe("mock");
  });

  it("builds database URLs with a validated port", () => {
    expect(buildDatabaseUrl(5433, "krypto_x")).toBe(
      "postgresql://krypto:krypto_local@127.0.0.1:5433/krypto_x",
    );
    expect(() => buildDatabaseUrl(0, "krypto_x")).toThrow(/Invalid TCP port/);
  });
});

// ---------------------------------------------------------------------------
// Production / credential refusal
// ---------------------------------------------------------------------------

describe("production and credential refusal", () => {
  it("refuses NODE_ENV=production", () => {
    expect(() => assertNotProduction({ NODE_ENV: "production" })).toThrow(
      /must not run under NODE_ENV=production/,
    );
    expect(() => assertNotProduction({ NODE_ENV: "development" })).not.toThrow();
  });

  it("only allows disabled/shadow rollout in the harness", () => {
    expect(() => assertHarnessRollout("disabled")).not.toThrow();
    expect(() => assertHarnessRollout("shadow")).not.toThrow();
    for (const mode of ["paper", "live", "production"]) {
      expect(() => assertHarnessRollout(mode)).toThrow(/forbidden/);
    }
    expect(() => assertHarnessRollout("weird")).toThrow(/Unknown rollout/);
  });

  it("detects production-looking database URLs", () => {
    expect(
      isProductionLikeDbUrl(
        "postgresql://u:p@db.abc.supabase.co:5432/postgres",
      ),
    ).toBe(true);
    expect(
      isProductionLikeDbUrl("postgresql://u:p@x.rds.amazonaws.com/db"),
    ).toBe(true);
    expect(
      isProductionLikeDbUrl("postgresql://krypto@127.0.0.1:5433/krypto"),
    ).toBe(false);
  });

  const azureOpenAI = () => ({ baseURL: "x", deployment: "z" });
  const noAzureOpenAI = () => undefined;

  it("requires the explicit opt-in flag for smoke", () => {
    expect(() =>
      assertSmokeAllowed(
        { allowNetworkSmoke: false },
        { NODE_ENV: "development" },
        azureOpenAI,
      ),
    ).toThrow(/--allow-network-smoke/);
  });

  it("requires valid Azure OpenAI configuration for smoke", () => {
    expect(() =>
      assertSmokeAllowed(
        { allowNetworkSmoke: true },
        { NODE_ENV: "development" },
        noAzureOpenAI,
      ),
    ).toThrow(/Azure OpenAI configuration/);
  });

  it("refuses production node env and production databases for smoke", () => {
    expect(() =>
      assertSmokeAllowed(
        { allowNetworkSmoke: true },
        { NODE_ENV: "production" },
        azureOpenAI,
      ),
    ).toThrow(/NODE_ENV=production/);
    expect(() =>
      assertSmokeAllowed(
        { allowNetworkSmoke: true },
        {
          NODE_ENV: "development",
          DIRECT_URL: "postgresql://u:p@db.x.supabase.co:5432/postgres",
        },
        azureOpenAI,
      ),
    ).toThrow(/production-looking DIRECT_URL/);
  });

  it("passes smoke gating when opted in with real credentials", () => {
    expect(() =>
      assertSmokeAllowed(
        { allowNetworkSmoke: true },
        { NODE_ENV: "development", DATABASE_URL: "postgresql://127.0.0.1/k" },
        azureOpenAI,
      ),
    ).not.toThrow();
  });

  it("preserves Azure OpenAI config but forces smoke/shadow with no API keys or analytics", () => {
    const env = buildSmokeEnv({
      ports: { app: 3000, db: 5455 },
      databaseName: "krypto_smoke",
      baseEnv: {
        AZURE_OPENAI_BASE_URL: "https://x.openai.azure.com/openai/v1",
        AZURE_OPENAI_DEPLOYMENT_NAME: "gpt-5.6-luna",
        AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
        AZURE_OPENAI_API_KEY: "must-not-survive",
        POSTHOG_API_KEY: "phc_real",
        RESEND_API_KEY: "re_real",
      },
    });
    expect(env.AGENT_HARNESS_MODE).toBe("smoke");
    expect(env.ROLLOUT_MODE).toBe("shadow");
    expect(env.AZURE_OPENAI_BASE_URL).toBe(
      "https://x.openai.azure.com/openai/v1",
    );
    expect(env.AZURE_OPENAI_DEPLOYMENT_NAME).toBe("gpt-5.6-luna");
    expect(env.AZURE_CLIENT_ID).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(env.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(env.POSTHOG_API_KEY).toBeUndefined();
    expect(env.RESEND_API_KEY).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Exact command construction (cleanup seams)
// ---------------------------------------------------------------------------

describe("exact resource command construction", () => {
  it("scopes compose commands to the exact project name", () => {
    expect(buildComposeUpArgs("krypto-harness-x")).toEqual([
      "compose",
      "-p",
      "krypto-harness-x",
      "up",
      "-d",
    ]);
    expect(buildComposeDownArgs("krypto-harness-x")).toEqual([
      "compose",
      "-p",
      "krypto-harness-x",
      "down",
      "--volumes",
    ]);
    expect(buildComposePsArgs("krypto-harness-x")).toEqual([
      "compose",
      "-p",
      "krypto-harness-x",
      "ps",
      "--format",
      "json",
    ]);
    expect(buildPgIsReadyArgs("krypto-harness-x", "krypto_x")).toEqual([
      "compose",
      "-p",
      "krypto-harness-x",
      "exec",
      "-T",
      "db",
      "pg_isready",
      "-U",
      "krypto",
      "-d",
      "krypto_x",
    ]);
  });

  it("never constructs a name-based or wildcard teardown", () => {
    const args = buildComposeDownArgs("krypto-harness-x");
    expect(args.join(" ")).not.toContain("*");
    expect(args).not.toContain("--rmi");
    expect(args).toContain("-p");
  });

  it("reconstructs only the exact fixture Compose environment", () => {
    expect(
      buildComposeLifecycleEnv({
        ports: { app: 3000, db: 5544 },
        databaseName: "krypto_feature",
      }),
    ).toEqual({
      KRYPTO_DB_HOST_PORT: "5544",
      KRYPTO_DB_NAME: "krypto_feature",
      KRYPTO_DB_USER: "krypto",
      KRYPTO_DB_PASSWORD: "krypto_local",
    });
  });
});

// ---------------------------------------------------------------------------
// PID ownership
// ---------------------------------------------------------------------------

describe("pid ownership verification", () => {
  const manifest = { worktreePath: WORKTREE, ports: { app: 3210, db: 5433 } };

  it("refuses invalid or system pids", () => {
    expect(
      verifyPidOwnership({ pid: null, manifest, readCmdline: () => "next dev" }),
    ).toBe(false);
    expect(
      verifyPidOwnership({ pid: 1, manifest, readCmdline: () => "next dev" }),
    ).toBe(false);
  });

  it("refuses when the process is gone", () => {
    expect(
      verifyPidOwnership({ pid: 4242, manifest, readCmdline: () => null }),
    ).toBe(false);
  });

  it("refuses a non-Next process even at the right pid", () => {
    expect(
      verifyPidOwnership({
        pid: 4242,
        manifest,
        readCmdline: () => "postgres: writer process",
      }),
    ).toBe(false);
  });

  it("refuses a Next process from a different worktree", () => {
    expect(
      verifyPidOwnership({
        pid: 4242,
        manifest,
        readCmdline: () =>
          "node /some/other/worktree/node_modules/.bin/next dev",
      }),
    ).toBe(false);
  });

  it("accepts this worktree's Next process by binary path", () => {
    expect(
      verifyPidOwnership({
        pid: 4242,
        manifest,
        readCmdline: () => `node ${WORKTREE}/node_modules/.bin/next dev -p 3210`,
      }),
    ).toBe(true);
  });

  it("accepts a next-server tied to the app port", () => {
    expect(
      verifyPidOwnership({
        pid: 4242,
        manifest,
        readCmdline: () => "next-server (v16.2.1) listening on :3210",
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Manifest redaction + state
// ---------------------------------------------------------------------------

describe("manifest state and redaction", () => {
  it("builds a versioned, secret-free manifest that round-trips", () => {
    const manifest = buildManifest(baseManifestInput());
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.status).toBe("running");
    expect(() => assertManifestHasNoSecrets(manifest)).not.toThrow();

    const roundTrip = parseManifest(serializeManifest(manifest));
    expect(roundTrip).toEqual(manifest);
  });

  it("never persists a connection string or credential field", () => {
    const serialized = serializeManifest(buildManifest(baseManifestInput()));
    expect(serialized.toLowerCase()).not.toContain("postgresql://");
    expect(serialized.toLowerCase()).not.toContain("password");
    expect(serialized.toLowerCase()).not.toContain("api_key");
  });

  it("allows harmless paths containing the word secret", () => {
    const worktreePath = "/home/dev/secret-project/worktree";
    const id = deriveWorktreeId(worktreePath);
    const manifest = buildManifest({
      ...baseManifestInput(),
      id,
      worktreePath,
      projectName: deriveProjectName(id),
      databaseName: deriveDatabaseName(id),
      artifacts: buildArtifacts(deriveHarnessDir(worktreePath, id)),
    });
    expect(() => assertManifestHasNoSecrets(manifest)).not.toThrow();
  });

  it("rejects unsupported manifest fields", () => {
    const manifest = buildManifest(baseManifestInput());
    expect(() =>
      parseManifest(
        JSON.stringify({
          ...manifest,
          DATABASE_URL: "postgresql://production",
        }),
      ),
    ).toThrow(/unsupported fields/);
  });

  it("refuses a manifest owned by another worktree", () => {
    const manifest = buildManifest(baseManifestInput());
    expect(() => assertManifestOwnership(manifest, OTHER_WORKTREE)).toThrow(
      /does not belong/,
    );
    expect(() => assertManifestOwnership(manifest, WORKTREE)).not.toThrow();
  });

  it("requires a recorded running harness to stop before another start", () => {
    expect(() =>
      assertHarnessCanStart(buildManifest(baseManifestInput())),
    ).toThrow(/already recorded as running/);
    expect(() =>
      assertHarnessCanStart(
        markManifestStopped(
          buildManifest(baseManifestInput()),
          "2026-08-10T01:00:00.000Z",
        ),
      ),
    ).not.toThrow();
  });

  it("rejects an unsupported manifest version", () => {
    const raw = JSON.stringify({
      ...buildManifest(baseManifestInput()),
      version: 999,
    });
    expect(() => parseManifest(raw)).toThrow(
      /Unsupported harness manifest version/,
    );
  });

  it("requires core fields when parsing", () => {
    const raw = JSON.stringify({ version: MANIFEST_VERSION });
    expect(() => parseManifest(raw)).toThrow(/missing required field/);
  });

  it("marks the manifest stopped without dropping evidence paths", () => {
    const manifest = buildManifest(baseManifestInput());
    const stopped = markManifestStopped(manifest, "2026-08-10T01:00:00.000Z");
    expect(stopped.status).toBe("stopped");
    expect(stopped.pid).toBeNull();
    expect(stopped.stoppedAt).toBe("2026-08-10T01:00:00.000Z");
    expect(stopped.artifacts).toEqual(manifest.artifacts);
  });
});

// ---------------------------------------------------------------------------
// Failure cleanup seams (deterministic, no Docker)
// ---------------------------------------------------------------------------

describe("failure cleanup seams", () => {
  it("cleanup targets the exact project and never signals an unowned pid", () => {
    const manifest = buildManifest(baseManifestInput());
    expect(buildComposeDownArgs(manifest.projectName)).toEqual([
      "compose",
      "-p",
      manifest.projectName,
      "down",
      "--volumes",
    ]);
    const owned = verifyPidOwnership({
      pid: manifest.pid,
      manifest,
      readCmdline: () => "some-unrelated-daemon",
    });
    expect(owned).toBe(false);
  });

  it("scopes the artifact directory under the ignored .harness path", () => {
    const artifacts = buildArtifacts(
      deriveHarnessDir(WORKTREE, deriveWorktreeId(WORKTREE)),
    );
    expect(artifacts.dir).toContain(`${WORKTREE}/.harness/`);
    expect(artifacts.manifest.endsWith("manifest.json")).toBe(true);
    expect(artifacts.nextLog.endsWith("next-dev.log")).toBe(true);
    expect(artifacts.screenshots.endsWith("screenshots")).toBe(true);
  });

  it("keeps two worktrees' projects and databases fully disjoint", () => {
    const a = buildManifest(baseManifestInput());
    const otherId = deriveWorktreeId(OTHER_WORKTREE);
    const b = buildManifest({
      ...baseManifestInput(),
      id: otherId,
      worktreePath: OTHER_WORKTREE,
      projectName: deriveProjectName(otherId),
      databaseName: deriveDatabaseName(otherId),
      artifacts: buildArtifacts(deriveHarnessDir(OTHER_WORKTREE, otherId)),
    });
    expect(a.projectName).not.toBe(b.projectName);
    expect(a.databaseName).not.toBe(b.databaseName);
    expect(a.artifacts.dir).not.toBe(b.artifacts.dir);
  });
});
