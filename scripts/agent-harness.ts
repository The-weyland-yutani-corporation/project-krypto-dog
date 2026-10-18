/**
 * Worktree-safe application harness for Project Krypto.
 *
 * Mock-first by default: `up` boots the full app with deterministic providers,
 * `AGENT_HARNESS_MODE=mock`, `ROLLOUT_MODE=disabled`, and no external network or
 * production credentials. `up --shadow` uses deterministic providers under
 * `shadow` (still no network, no trade mutation). `smoke` is an explicit,
 * configuration-gated, read-only real-provider check that stays shadow and never
 * executes a trade. `status` and `down` operate only on resources this
 * invocation created, verified through a versioned, secret-free manifest.
 *
 * See specs/governance.md.
 *
 * This module exports pure, side-effect-free helpers (ids, ports, option/env
 * construction, refusal checks, exact command construction, pid ownership, and
 * manifest state) so they can be unit tested without Docker or the network. The
 * CLI at the bottom composes them with process/file side effects.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { isLoopbackPostgresUrl } from "../src/lib/postgres-url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MANIFEST_VERSION = 1 as const;

/** Local fixture database identity (matches docker-compose.yml defaults). */
const HARNESS_DB_USER = "krypto";
const HARNESS_DB_PASSWORD = "krypto_local";
const HARNESS_DB_HOST = "127.0.0.1";

/**
 * Environment keys the harness always constructs explicitly. Anything matching
 * these prefixes is stripped from the inherited base environment so a
 * developer's real credentials can never leak into a mock/shadow boot.
 */
const SENSITIVE_ENV_PREFIXES = [
  "ANTHROPIC_FOUNDRY_",
  "AZURE_OPENAI_",
  "POSTHOG_",
  "RESEND_",
  "ALERT_EMAIL_",
  "COINBASE_",
  "CDP_",
  "AGENT_HARNESS_",
] as const;

const SENSITIVE_ENV_EXACT = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_USERNAME",
  "AZURE_PASSWORD",
  "DATABASE_URL",
  "DIRECT_URL",
  "ROLLOUT_MODE",
  "APP_ORIGIN",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "CRON_SECRET",
  "PORT",
  "COMPOSE_PROJECT_NAME",
  "KRYPTO_DB_HOST_PORT",
  "KRYPTO_DB_NAME",
  "KRYPTO_DB_USER",
  "KRYPTO_DB_PASSWORD",
] as const;

export type HarnessMode = "mock" | "smoke";
export type HarnessRollout = "disabled" | "shadow";
export type HarnessScenario = "steady" | "dip" | "crash";
export type HarnessDecision = "HOLD" | "BUY" | "SELL";

export interface HarnessPorts {
  app: number;
  db: number;
}

export interface HarnessArtifacts {
  dir: string;
  manifest: string;
  nextLog: string;
  screenshots: string;
}

export interface HarnessManifest {
  version: typeof MANIFEST_VERSION;
  id: string;
  worktreePath: string;
  projectName: string;
  databaseName: string;
  mode: HarnessMode;
  rollout: HarnessRollout;
  scenario: HarnessScenario | null;
  decision: HarnessDecision | null;
  ports: HarnessPorts;
  pid: number | null;
  startedAt: string;
  stoppedAt: string | null;
  status: "running" | "stopped" | "failed";
  artifacts: HarnessArtifacts;
}

// ---------------------------------------------------------------------------
// Identifiers (pure)
// ---------------------------------------------------------------------------

/**
 * Derive a stable, filesystem/Compose/Postgres-safe id from a canonical
 * repository path. The slug keeps the worktree recognizable; the hash of the
 * full path guarantees two worktrees with the same basename never collide.
 */
export function deriveWorktreeId(canonicalPath: string): string {
  const normalized = canonicalPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalized.split("/").filter(Boolean).pop() ?? "worktree";
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "worktree";
  const hash = crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 8);
  return `${slug}-${hash}`;
}

/** Docker Compose project name for a worktree id (lowercase, dash-safe). */
export function deriveProjectName(id: string): string {
  return `krypto-harness-${id}`;
}

/**
 * Postgres database name for a worktree id. Postgres identifiers must start with
 * a letter and be <= 63 chars; dashes are not allowed unquoted, so use
 * underscores.
 */
export function deriveDatabaseName(id: string): string {
  const safe = id.replace(/[^a-z0-9]+/g, "_").replace(/^_+/, "");
  return `krypto_${safe}`.slice(0, 63);
}

/** Ignored per-worktree artifact directory. */
export function deriveHarnessDir(worktreePath: string, id: string): string {
  return path.join(worktreePath, ".harness", id);
}

export function buildArtifacts(harnessDir: string): HarnessArtifacts {
  return {
    dir: harnessDir,
    manifest: path.join(harnessDir, "manifest.json"),
    nextLog: path.join(harnessDir, "next-dev.log"),
    screenshots: path.join(harnessDir, "screenshots"),
  };
}

// ---------------------------------------------------------------------------
// Free-port allocation (pure with injectable server factory)
// ---------------------------------------------------------------------------

export interface EphemeralServerLike {
  once(event: "error", listener: (error: Error) => void): void;
  listen(port: number, host: string, callback: () => void): void;
  address(): { port: number } | string | null;
  close(callback?: () => void): void;
}

export function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TCP port: ${String(port)}`);
  }
}

async function listenEphemeral(
  createServer: () => EphemeralServerLike,
  host: string,
): Promise<{ server: EphemeralServerLike; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : Number.NaN;
      if (!Number.isInteger(port) || port <= 0) {
        server.close(() =>
          reject(new Error("Could not determine an ephemeral port")),
        );
        return;
      }
      resolve({ server, port });
    });
  });
}

/**
 * Allocate `count` distinct free TCP ports. All candidate sockets are held open
 * simultaneously and then released, so the returned ports are guaranteed
 * distinct. The server factory is injectable for deterministic unit tests.
 */
export async function findFreePorts(
  count: number,
  options: { host?: string; createServer?: () => EphemeralServerLike } = {},
): Promise<number[]> {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("Port count must be a positive integer");
  }
  const host = options.host ?? HARNESS_DB_HOST;
  const createServer =
    options.createServer ?? (() => net.createServer() as EphemeralServerLike);
  const servers: EphemeralServerLike[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const { server, port } = await listenEphemeral(createServer, host);
      servers.push(server);
      ports.push(port);
    }
  } finally {
    for (const server of servers) {
      server.close();
    }
  }
  for (const port of ports) {
    assertValidPort(port);
  }
  return ports;
}

// ---------------------------------------------------------------------------
// Refusal checks (pure)
// ---------------------------------------------------------------------------

export function assertNotProduction(
  env: Record<string, string | undefined>,
): void {
  if ((env.NODE_ENV ?? "").toLowerCase() === "production") {
    throw new Error("The harness must not run under NODE_ENV=production.");
  }
}

/**
 * Only `disabled` and `shadow` are valid harness rollout modes. `paper`,
 * `live`, and anything production-adjacent are rejected outright.
 */
export function assertHarnessRollout(mode: string): void {
  const normalized = mode.toLowerCase();
  if (
    normalized === "paper" ||
    normalized === "live" ||
    normalized === "production"
  ) {
    throw new Error(
      `Rollout mode "${mode}" is forbidden in the harness; only "disabled" or "shadow" are allowed.`,
    );
  }
  if (normalized !== "disabled" && normalized !== "shadow") {
    throw new Error(
      `Unknown rollout mode "${mode}"; expected "disabled" or "shadow".`,
    );
  }
}

/** True only for a parsed PostgreSQL URL with an explicit loopback host. */
export function isLoopbackDbUrl(url: string): boolean {
  return isLoopbackPostgresUrl(url);
}

// ---------------------------------------------------------------------------
// Options (pure)
// ---------------------------------------------------------------------------

const SCENARIOS: readonly HarnessScenario[] = ["steady", "dip", "crash"];
const DECISIONS: readonly HarnessDecision[] = ["HOLD", "BUY", "SELL"];

export interface UpOptions {
  shadow: boolean;
  scenario: HarnessScenario | null;
  decision: HarnessDecision | null;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseUpOptions(argv: string[]): UpOptions {
  let shadow = false;
  let scenario: HarnessScenario | null = null;
  let decision: HarnessDecision | null = null;
  let rollout: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--shadow":
        shadow = true;
        break;
      case "--rollout":
        rollout = requireValue(argument, argv[index + 1]);
        index += 1;
        break;
      case "--scenario": {
        const value = requireValue(argument, argv[index + 1]);
        if (!SCENARIOS.includes(value as HarnessScenario)) {
          throw new Error(
            `--scenario must be one of ${SCENARIOS.join("|")}; received "${value}".`,
          );
        }
        scenario = value as HarnessScenario;
        index += 1;
        break;
      }
      case "--decision": {
        const value = requireValue(argument, argv[index + 1]);
        if (!DECISIONS.includes(value as HarnessDecision)) {
          throw new Error(
            `--decision must be one of ${DECISIONS.join("|")}; received "${value}".`,
          );
        }
        decision = value as HarnessDecision;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (rollout !== null) {
    // Rejects paper/live/production; only disabled|shadow survive.
    assertHarnessRollout(rollout);
    if (rollout.toLowerCase() === "shadow") shadow = true;
  }

  if ((scenario !== null || decision !== null) && !shadow) {
    throw new Error(
      "--scenario and --decision require --shadow (they configure deterministic shadow providers).",
    );
  }

  if (shadow) {
    scenario = scenario ?? "steady";
    decision = decision ?? "HOLD";
  }

  return { shadow, scenario, decision };
}

export interface SmokeOptions {
  allowNetworkSmoke: boolean;
}

export function parseSmokeOptions(argv: string[]): SmokeOptions {
  let allowNetworkSmoke = false;
  for (const argument of argv) {
    if (argument === "--allow-network-smoke") {
      allowNetworkSmoke = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { allowNetworkSmoke };
}

// ---------------------------------------------------------------------------
// Environment construction (pure)
// ---------------------------------------------------------------------------

export function buildDatabaseUrl(
  port: number,
  databaseName: string,
  user: string = HARNESS_DB_USER,
  password: string = HARNESS_DB_PASSWORD,
  host: string = HARNESS_DB_HOST,
): string {
  assertValidPort(port);
  return `postgresql://${user}:${password}@${host}:${port}/${databaseName}`;
}

/** Local, obviously-non-production fixture configuration for instrumentation. */
function fixtureCredentials(): Record<string, string> {
  return {
    AZURE_OPENAI_BASE_URL: "https://stub.openai.azure.com/openai/v1",
    AZURE_OPENAI_DEPLOYMENT_NAME: "krypto-harness-stub",
    CRON_SECRET: "harness-cron-secret",
    ADMIN_PASSWORD: "harness-admin-password",
    ADMIN_SESSION_SECRET: "harness-admin-session-secret",
  };
}

/**
 * Strip every sensitive key from an inherited environment so nothing real can
 * leak into a constructed harness environment.
 */
export function sanitizeBaseEnv(
  base: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_EXACT.includes(key as (typeof SENSITIVE_ENV_EXACT)[number])) {
      continue;
    }
    if (SENSITIVE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

export interface UpEnvInput {
  shadow: boolean;
  scenario: HarnessScenario | null;
  decision: HarnessDecision | null;
  ports: HarnessPorts;
  databaseName: string;
}

/**
 * Construct the explicit mock/shadow environment. Never includes Foundry,
 * Coinbase, PostHog, or email credentials; PostHog and email therefore run as
 * their existing no-op sinks.
 */
export function buildUpEnv(input: UpEnvInput): Record<string, string> {
  const databaseUrl = buildDatabaseUrl(input.ports.db, input.databaseName);
  const env: Record<string, string> = {
    NODE_ENV: "development",
    AGENT_HARNESS_MODE: "mock",
    ROLLOUT_MODE: input.shadow ? "shadow" : "disabled",
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    PORT: String(input.ports.app),
    APP_ORIGIN: `http://${HARNESS_DB_HOST}:${input.ports.app}`,
    KRYPTO_DB_HOST_PORT: String(input.ports.db),
    KRYPTO_DB_NAME: input.databaseName,
    KRYPTO_DB_USER: HARNESS_DB_USER,
    KRYPTO_DB_PASSWORD: HARNESS_DB_PASSWORD,
    NEXT_TELEMETRY_DISABLED: "1",
    ...fixtureCredentials(),
  };
  if (input.shadow) {
    env.AGENT_HARNESS_SCENARIO = input.scenario ?? "steady";
    env.AGENT_HARNESS_DECISION = input.decision ?? "HOLD";
  }
  // Rollout must never be paper/live here — assert the invariant we just built.
  assertHarnessRollout(env.ROLLOUT_MODE);
  assertNotProduction(env);
  return env;
}

export interface SmokeEnvInput {
  ports: HarnessPorts;
  databaseName: string;
  /** Real credentials source (validated by assertSmokeAllowed first). */
  baseEnv: Record<string, string | undefined>;
}

/**
 * Construct the explicit smoke environment. Preserves only the Azure OpenAI v1
 * endpoint/deployment configuration and optional managed-identity selector from
 * the base env (Coinbase needs none), forces `smoke` + `shadow`, points the app
 * at the isolated harness database, and still omits API keys, PostHog, and email
 * credentials so no analytics/email events are emitted.
 */
export function buildSmokeEnv(input: SmokeEnvInput): Record<string, string> {
  const databaseUrl = buildDatabaseUrl(input.ports.db, input.databaseName);
  const env: Record<string, string> = {
    NODE_ENV: "development",
    AGENT_HARNESS_MODE: "smoke",
    ROLLOUT_MODE: "shadow",
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    PORT: String(input.ports.app),
    APP_ORIGIN: `http://${HARNESS_DB_HOST}:${input.ports.app}`,
    KRYPTO_DB_HOST_PORT: String(input.ports.db),
    KRYPTO_DB_NAME: input.databaseName,
    KRYPTO_DB_USER: HARNESS_DB_USER,
    KRYPTO_DB_PASSWORD: HARNESS_DB_PASSWORD,
    NEXT_TELEMETRY_DISABLED: "1",
    ...fixtureCredentials(),
  };
  // Authentication is attended Entra/managed identity; provider API keys stay scrubbed.
  for (const key of [
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_DEPLOYMENT_NAME",
    "AZURE_CLIENT_ID",
  ]) {
    const value = input.baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  assertHarnessRollout(env.ROLLOUT_MODE);
  assertNotProduction(env);
  return env;
}

/**
 * Gate the smoke command: explicit opt-in, valid Azure OpenAI v1 configuration,
 * and never a production node env or a non-loopback database.
 */
export function assertSmokeAllowed(
  options: SmokeOptions,
  env: Record<string, string | undefined>,
  resolveProviderConfig: (
    env: Record<string, string | undefined>,
  ) => unknown | undefined,
): void {
  if (!options.allowNetworkSmoke) {
    throw new Error(
      "Real-provider smoke requires the explicit --allow-network-smoke flag.",
    );
  }
  assertNotProduction(env);
  if (!resolveProviderConfig(env)) {
    throw new Error(
      "Real-provider smoke requires valid Azure OpenAI configuration " +
        "(AZURE_OPENAI_BASE_URL + AZURE_OPENAI_DEPLOYMENT_NAME) and an authenticated Entra identity.",
    );
  }
  for (const key of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const value = env[key];
    if (value && !isLoopbackDbUrl(value)) {
      throw new Error(
        `Refusing to smoke against a non-loopback or invalid ${key}.`,
      );
    }
  }
}

/**
 * Merge a constructed harness environment onto a sanitized base so no inherited
 * secret survives, while keeping PATH/HOME and other benign OS variables.
 */
export function buildSpawnEnv(
  harnessEnv: Record<string, string>,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return { ...sanitizeBaseEnv(base), ...harnessEnv };
}

// ---------------------------------------------------------------------------
// Exact command construction (pure)
// ---------------------------------------------------------------------------

export function buildComposeUpArgs(projectName: string): string[] {
  return ["compose", "-p", projectName, "up", "-d"];
}

/** Exact teardown command: only this project, including its volumes. */
export function buildComposeDownArgs(projectName: string): string[] {
  return ["compose", "-p", projectName, "down", "--volumes"];
}

export function buildComposePsArgs(projectName: string): string[] {
  return ["compose", "-p", projectName, "ps", "--format", "json"];
}

export function buildPgIsReadyArgs(
  projectName: string,
  databaseName: string,
): string[] {
  return [
    "compose",
    "-p",
    projectName,
    "exec",
    "-T",
    "db",
    "pg_isready",
    "-U",
    HARNESS_DB_USER,
    "-d",
    databaseName,
  ];
}

// ---------------------------------------------------------------------------
// PID ownership (pure with injectable lookup)
// ---------------------------------------------------------------------------

export interface PidOwnershipInput {
  pid: number | null;
  manifest: Pick<HarnessManifest, "worktreePath" | "ports">;
  readCmdline: (pid: number) => string | null;
}

/**
 * Verify the recorded pid still names a Next process that belongs to *this*
 * worktree before any signal is sent. Both signals must hold: the command must
 * look like Next, and it must be tied to this worktree (its node_modules binary
 * path or its app port). Never trusts the pid alone and never matches by name.
 */
export function verifyPidOwnership(input: PidOwnershipInput): boolean {
  const { pid } = input;
  if (pid === null || !Number.isInteger(pid) || pid <= 1) return false;
  const cmd = input.readCmdline(pid);
  if (!cmd) return false;

  const looksLikeNext =
    /(^|[\s/\\])next([\s/\\-]|$)/i.test(cmd) ||
    /next-server/i.test(cmd) ||
    /next[\\/]dist/i.test(cmd);
  const tiedToWorktree =
    cmd.includes(input.manifest.worktreePath) ||
    cmd.includes(`PORT=${input.manifest.ports.app}`) ||
    new RegExp(`(^|\\s)-p\\s+${input.manifest.ports.app}(\\s|$)`).test(cmd) ||
    cmd.includes(`:${input.manifest.ports.app}`);

  return looksLikeNext && tiedToWorktree;
}

// ---------------------------------------------------------------------------
// Manifest (pure)
// ---------------------------------------------------------------------------

export interface BuildManifestInput {
  id: string;
  worktreePath: string;
  projectName: string;
  databaseName: string;
  mode: HarnessMode;
  rollout: HarnessRollout;
  scenario: HarnessScenario | null;
  decision: HarnessDecision | null;
  ports: HarnessPorts;
  pid: number | null;
  startedAt: string;
  artifacts: HarnessArtifacts;
  status?: HarnessManifest["status"];
}

export function buildManifest(input: BuildManifestInput): HarnessManifest {
  return {
    version: MANIFEST_VERSION,
    id: input.id,
    worktreePath: input.worktreePath,
    projectName: input.projectName,
    databaseName: input.databaseName,
    mode: input.mode,
    rollout: input.rollout,
    scenario: input.scenario,
    decision: input.decision,
    ports: input.ports,
    pid: input.pid,
    startedAt: input.startedAt,
    stoppedAt: null,
    status: input.status ?? "running",
    artifacts: input.artifacts,
  };
}

export function serializeManifest(manifest: HarnessManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseManifest(text: string): HarnessManifest {
  const data = JSON.parse(text) as Partial<HarnessManifest>;
  const allowedKeys = new Set([
    "version",
    "id",
    "worktreePath",
    "projectName",
    "databaseName",
    "mode",
    "rollout",
    "scenario",
    "decision",
    "ports",
    "pid",
    "startedAt",
    "stoppedAt",
    "status",
    "artifacts",
  ]);
  const unknownKeys = Object.keys(data).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Harness manifest contains unsupported fields: ${unknownKeys.join(", ")}.`,
    );
  }
  if (data.version !== MANIFEST_VERSION) {
    throw new Error(
      `Unsupported harness manifest version: ${String(data.version)} (expected ${MANIFEST_VERSION}).`,
    );
  }
  for (const key of [
    "id",
    "worktreePath",
    "projectName",
    "databaseName",
    "ports",
  ] as const) {
    if (data[key] === undefined || data[key] === null) {
      throw new Error(`Harness manifest is missing required field: ${key}.`);
    }
  }
  if (data.mode !== "mock" && data.mode !== "smoke") {
    throw new Error("Harness manifest has an invalid mode.");
  }
  if (data.rollout !== "disabled" && data.rollout !== "shadow") {
    throw new Error("Harness manifest has an invalid rollout mode.");
  }
  if (data.status !== "running" && data.status !== "stopped" && data.status !== "failed") {
    throw new Error("Harness manifest has an invalid status.");
  }
  if (
    !data.ports ||
    !Number.isInteger(data.ports.app) ||
    !Number.isInteger(data.ports.db)
  ) {
    throw new Error("Harness manifest has invalid ports.");
  }
  assertValidPort(data.ports.app);
  assertValidPort(data.ports.db);
  if (
    data.pid !== null &&
    (!Number.isInteger(data.pid) || (data.pid as number) <= 1)
  ) {
    throw new Error("Harness manifest has an invalid pid.");
  }
  if (!data.artifacts || typeof data.artifacts !== "object") {
    throw new Error("Harness manifest has invalid artifacts.");
  }
  return data as HarnessManifest;
}

export function assertManifestOwnership(
  manifest: HarnessManifest,
  canonicalWorktreePath: string,
): void {
  const expectedId = deriveWorktreeId(canonicalWorktreePath);
  const expectedArtifacts = buildArtifacts(
    deriveHarnessDir(canonicalWorktreePath, expectedId),
  );
  if (
    manifest.worktreePath !== canonicalWorktreePath ||
    manifest.id !== expectedId ||
    manifest.projectName !== deriveProjectName(expectedId) ||
    manifest.databaseName !== deriveDatabaseName(expectedId) ||
    manifest.artifacts.dir !== expectedArtifacts.dir ||
    manifest.artifacts.manifest !== expectedArtifacts.manifest ||
    manifest.artifacts.nextLog !== expectedArtifacts.nextLog ||
    manifest.artifacts.screenshots !== expectedArtifacts.screenshots
  ) {
    throw new Error(
      "Harness manifest does not belong to the current worktree; refusing lifecycle operation.",
    );
  }
}

export function assertHarnessCanStart(
  existing: HarnessManifest | null,
): void {
  if (existing?.status === "running") {
    throw new Error(
      "A harness is already recorded as running for this worktree. Run `npm run harness:down` before starting another.",
    );
  }
}

/**
 * Defensive assertion that a serialized manifest carries no secret material.
 * The manifest is deliberately restricted to non-sensitive scalars.
 */
export function assertManifestHasNoSecrets(manifest: HarnessManifest): void {
  const entries = Object.entries(manifest as unknown as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (/password|secret|api_?key|authorization/i.test(key)) {
      throw new Error(`Harness manifest contains a sensitive field "${key}".`);
    }
    if (
      typeof value === "string" &&
      /^(postgres(?:ql)?:\/\/|sk-|phc_|ghp_)/i.test(value)
    ) {
      throw new Error(`Harness manifest contains a credential-like value.`);
    }
  }
}

export function buildComposeLifecycleEnv(
  manifest: Pick<HarnessManifest, "ports" | "databaseName">,
): Record<string, string> {
  return {
    KRYPTO_DB_HOST_PORT: String(manifest.ports.db),
    KRYPTO_DB_NAME: manifest.databaseName,
    KRYPTO_DB_USER: HARNESS_DB_USER,
    KRYPTO_DB_PASSWORD: HARNESS_DB_PASSWORD,
  };
}

export function markManifestStopped(
  manifest: HarnessManifest,
  stoppedAt: string,
): HarnessManifest {
  return { ...manifest, status: "stopped", stoppedAt, pid: null };
}

// ---------------------------------------------------------------------------
// Side-effecting helpers (not exercised by Jest)
// ---------------------------------------------------------------------------

function readProcessCmdline(pid: number): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const output = (result.stdout ?? "").trim();
  return output || null;
}

function runDocker(args: string[], env: Record<string, string>): number {
  const result = spawnSync("docker", args, {
    stdio: "inherit",
    env,
  });
  if (result.error) {
    throw new Error(`docker ${args.join(" ")} failed: ${result.error.message}`);
  }
  return result.status ?? 1;
}

function runDockerQuiet(
  args: string[],
  env: Record<string, string>,
): { status: number; stdout: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", env });
  return {
    status: result.error ? 1 : (result.status ?? 1),
    stdout: result.stdout ?? "",
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPostgres(
  projectName: string,
  databaseName: string,
  env: Record<string, string>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const args = buildPgIsReadyArgs(projectName, databaseName);
  while (Date.now() < deadline) {
    const { status } = runDockerQuiet(args, env);
    if (status === 0) return;
    await sleep(1000);
  }
  throw new Error(
    `PostgreSQL for project ${projectName} did not become ready within ${timeoutMs}ms.`,
  );
}

async function waitForHealth(
  appPort: number,
  timeoutMs = 90_000,
): Promise<Record<string, unknown>> {
  const url = `http://${HARNESS_DB_HOST}:${appPort}/api/health`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { "Cache-Control": "no-store" },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        return (await response.json()) as Record<string, unknown>;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  throw new Error(
    `Health endpoint at ${url} did not become ready within ${timeoutMs}ms (last: ${lastError}).`,
  );
}

function runNodeScript(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): void {
  const result = spawnSync(command, args, { stdio: "inherit", env, cwd });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${result.status}.`,
    );
  }
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  // The Next dev server is started detached, so it leads its own process group
  // (pgid === pid). Signaling the negative pid takes down the exact tree we
  // started — never a process matched by name. Fall back to the exact pid.
  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal);
  }
}

function startNextDev(
  appPort: number,
  env: Record<string, string>,
  cwd: string,
  logPath: string,
): number {
  const logFd = fs.openSync(logPath, "a");
  const nextBin = path.join(cwd, "node_modules", ".bin", "next");
  try {
    const child = spawn(nextBin, ["dev", "-p", String(appPort)], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error("Failed to start Next dev server (no pid).");
    }
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

interface BringUpConfig {
  worktreePath: string;
  id: string;
  projectName: string;
  databaseName: string;
  ports: HarnessPorts;
  mode: HarnessMode;
  rollout: HarnessRollout;
  scenario: HarnessScenario | null;
  decision: HarnessDecision | null;
  env: Record<string, string>;
}

async function bringUp(config: BringUpConfig): Promise<HarnessManifest> {
  const artifacts = buildArtifacts(deriveHarnessDir(config.worktreePath, config.id));
  fs.mkdirSync(artifacts.screenshots, { recursive: true });

  const spawnEnv = buildSpawnEnv(config.env);
  let nextPid: number | null = null;
  let composeStarted = false;

  try {
    // 1. Start the exact Compose project.
    const upStatus = runDocker(buildComposeUpArgs(config.projectName), spawnEnv);
    if (upStatus !== 0) {
      throw new Error(`docker compose up exited with status ${upStatus}.`);
    }
    composeStarted = true;

    // 2. Wait for PostgreSQL, then create the isolated database if needed.
    await waitForPostgres(config.projectName, config.databaseName, spawnEnv);
    runDockerQuiet(
      [
        "compose",
        "-p",
        config.projectName,
        "exec",
        "-T",
        "db",
        "createdb",
        "-U",
        HARNESS_DB_USER,
        config.databaseName,
      ],
      spawnEnv,
    ); // best-effort: default DB may already match; migrations are authoritative.

    // 3. Migrate and deterministically seed the isolated database.
    runNodeScript(
      "npx",
      ["--no-install", "drizzle-kit", "migrate"],
      spawnEnv,
      config.worktreePath,
    );
    runNodeScript(
      "npx",
      ["--no-install", "tsx", "scripts/seed.ts"],
      spawnEnv,
      config.worktreePath,
    );

    // 4. Start Next dev detached with logs under artifacts.
    nextPid = startNextDev(
      config.ports.app,
      spawnEnv,
      config.worktreePath,
      artifacts.nextLog,
    );

    // 5. Persist the manifest before waiting (so failures are still cleanable).
    const manifest = buildManifest({
      id: config.id,
      worktreePath: config.worktreePath,
      projectName: config.projectName,
      databaseName: config.databaseName,
      mode: config.mode,
      rollout: config.rollout,
      scenario: config.scenario,
      decision: config.decision,
      ports: config.ports,
      pid: nextPid,
      startedAt: new Date().toISOString(),
      artifacts,
    });
    assertManifestHasNoSecrets(manifest);
    fs.writeFileSync(artifacts.manifest, serializeManifest(manifest));

    // 6. Wait for the non-sensitive health endpoint.
    const health = await waitForHealth(config.ports.app);
    process.stdout.write(
      `\n✓ Harness is up.\n` +
        `  Health: ${JSON.stringify(health)}\n` +
        `  App:      http://${HARNESS_DB_HOST}:${config.ports.app}\n` +
        `  Console:  http://${HARNESS_DB_HOST}:${config.ports.app}/admin/login\n` +
        `  Database: postgres on host port ${config.ports.db} (db ${config.databaseName})\n` +
        `  Manifest: ${artifacts.manifest}\n` +
        `  Next log: ${artifacts.nextLog}\n` +
        `  Mode:     ${config.mode} · rollout ${config.rollout}` +
        (config.scenario ? ` · scenario ${config.scenario}` : "") +
        (config.decision ? ` · decision ${config.decision}` : "") +
        `\n  Stop:     npm run harness:down\n`,
    );
    return manifest;
  } catch (error) {
    // Clean up only what this invocation created.
    process.stderr.write(
      `\n✗ Harness bring-up failed: ${
        error instanceof Error ? error.message : String(error)
      }\n  Cleaning up resources created by this invocation…\n`,
    );
    if (nextPid !== null) {
      try {
        signalProcessTree(nextPid, "SIGTERM");
      } catch {
        // process may already be gone
      }
    }
    if (composeStarted) {
      runDocker(buildComposeDownArgs(config.projectName), spawnEnv);
    }
    // Record the failed state without deleting evidence.
    try {
      const failed = buildManifest({
        id: config.id,
        worktreePath: config.worktreePath,
        projectName: config.projectName,
        databaseName: config.databaseName,
        mode: config.mode,
        rollout: config.rollout,
        scenario: config.scenario,
        decision: config.decision,
        ports: config.ports,
        pid: null,
        startedAt: new Date().toISOString(),
        artifacts,
        status: "failed",
      });
      fs.writeFileSync(artifacts.manifest, serializeManifest(failed));
    } catch {
      // best effort
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI commands (side effects)
// ---------------------------------------------------------------------------

function canonicalWorktreePath(): string {
  return fs.realpathSync(process.cwd());
}

function assertNoRunningHarness(worktreePath: string, id: string): void {
  const artifacts = buildArtifacts(deriveHarnessDir(worktreePath, id));
  if (!fs.existsSync(artifacts.manifest)) return;
  const existing = parseManifest(fs.readFileSync(artifacts.manifest, "utf8"));
  assertManifestOwnership(existing, worktreePath);
  assertHarnessCanStart(existing);
}

async function commandUp(argv: string[]): Promise<void> {
  const options = parseUpOptions(argv);
  const worktreePath = canonicalWorktreePath();
  const id = deriveWorktreeId(worktreePath);
  assertNoRunningHarness(worktreePath, id);
  const projectName = deriveProjectName(id);
  const databaseName = deriveDatabaseName(id);
  const [appPort, dbPort] = await findFreePorts(2);
  const ports: HarnessPorts = { app: appPort, db: dbPort };
  const env = buildUpEnv({
    shadow: options.shadow,
    scenario: options.scenario,
    decision: options.decision,
    ports,
    databaseName,
  });
  await bringUp({
    worktreePath,
    id,
    projectName,
    databaseName,
    ports,
    mode: "mock",
    rollout: options.shadow ? "shadow" : "disabled",
    scenario: options.scenario,
    decision: options.decision,
    env,
  });
}

async function commandSmoke(argv: string[]): Promise<void> {
  const options = parseSmokeOptions(argv);
  const { resolveAzureOpenAIConfig } = await import("@/lib/config");
  assertSmokeAllowed(options, process.env, resolveAzureOpenAIConfig);

  const worktreePath = canonicalWorktreePath();
  const id = deriveWorktreeId(worktreePath);
  assertNoRunningHarness(worktreePath, id);
  const projectName = deriveProjectName(id);
  const databaseName = deriveDatabaseName(id);
  const [appPort, dbPort] = await findFreePorts(2);
  const ports: HarnessPorts = { app: appPort, db: dbPort };

  // Read-only real provider smoke first (Azure OpenAI + Coinbase only; no PostHog/email).
  process.stdout.write("▶ Read-only provider smoke (Azure OpenAI + Coinbase)…\n");
  const smokeEnv = buildSmokeEnv({ ports, databaseName, baseEnv: process.env });
  for (const [key, value] of Object.entries(smokeEnv)) {
    process.env[key] = value;
  }
  const { runReadOnlyProviderSmoke } = await import("@/deployment/provider-smoke");
  const smokeResult = await runReadOnlyProviderSmoke();
  process.stdout.write(`  ✓ ${JSON.stringify(smokeResult)}\n`);

  // Boot the app in smoke mode; execution is never invoked here.
  await bringUp({
    worktreePath,
    id,
    projectName,
    databaseName,
    ports,
    mode: "smoke",
    rollout: "shadow",
    scenario: null,
    decision: null,
    env: smokeEnv,
  });
}

function readManifestOrThrow(): HarnessManifest {
  const worktreePath = canonicalWorktreePath();
  const id = deriveWorktreeId(worktreePath);
  const artifacts = buildArtifacts(deriveHarnessDir(worktreePath, id));
  if (!fs.existsSync(artifacts.manifest)) {
    throw new Error(
      `No harness manifest found at ${artifacts.manifest}. Run \`npm run harness:up\` first.`,
    );
  }
  const manifest = parseManifest(fs.readFileSync(artifacts.manifest, "utf8"));
  assertManifestOwnership(manifest, worktreePath);
  return manifest;
}

async function commandStatus(): Promise<void> {
  const manifest = readManifestOrThrow();
  const spawnEnv = buildSpawnEnv(buildComposeLifecycleEnv(manifest));
  const ps = runDockerQuiet(buildComposePsArgs(manifest.projectName), spawnEnv);
  const pidOwned =
    manifest.pid !== null &&
    verifyPidOwnership({
      pid: manifest.pid,
      manifest,
      readCmdline: readProcessCmdline,
    });
  let health: Record<string, unknown> | string;
  try {
    const response = await fetch(
      `http://${HARNESS_DB_HOST}:${manifest.ports.app}/api/health`,
      { signal: AbortSignal.timeout(5000) },
    );
    health = response.ok ? await response.json() : `HTTP ${response.status}`;
  } catch (error) {
    health = error instanceof Error ? error.message : String(error);
  }
  process.stdout.write(
    `Harness ${manifest.id} (${manifest.status})\n` +
      `  Project:  ${manifest.projectName}\n` +
      `  Database: ${manifest.databaseName} (host port ${manifest.ports.db})\n` +
      `  App:      http://${HARNESS_DB_HOST}:${manifest.ports.app}\n` +
      `  Mode:     ${manifest.mode} · rollout ${manifest.rollout}\n` +
      `  Next pid: ${manifest.pid ?? "none"} (${pidOwned ? "owned" : "not owned / gone"})\n` +
      `  Health:   ${typeof health === "string" ? health : JSON.stringify(health)}\n` +
      `  Compose:  ${ps.stdout.trim() ? "running" : "not running"}\n` +
      `  Manifest: ${manifest.artifacts.manifest}\n`,
  );
}

async function commandDown(): Promise<void> {
  const manifest = readManifestOrThrow();
  const spawnEnv = buildSpawnEnv(buildComposeLifecycleEnv(manifest));

  // 1. Signal the exact recorded pid only after verifying it is still this
  //    worktree's Next process. Never kill by name.
  if (manifest.pid !== null) {
    const owned = verifyPidOwnership({
      pid: manifest.pid,
      manifest,
      readCmdline: readProcessCmdline,
    });
    if (owned) {
      try {
        signalProcessTree(manifest.pid, "SIGTERM");
        process.stdout.write(`✓ Signaled Next pid ${manifest.pid}.\n`);
      } catch (error) {
        process.stderr.write(
          `! Could not signal pid ${manifest.pid}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    } else {
      process.stdout.write(
        `! Recorded pid ${manifest.pid} is no longer this worktree's Next process; not signaling it.\n`,
      );
    }
  }

  // 2. Tear down exactly this Compose project and its volumes.
  const status = runDocker(
    buildComposeDownArgs(manifest.projectName),
    spawnEnv,
  );
  if (status !== 0) {
    throw new Error(`docker compose down exited with status ${status}.`);
  }

  // 3. Mark the manifest stopped; preserve logs and screenshots.
  const stopped = markManifestStopped(manifest, new Date().toISOString());
  fs.writeFileSync(manifest.artifacts.manifest, serializeManifest(stopped));
  process.stdout.write(
    `✓ Harness ${manifest.id} stopped. Logs/screenshots preserved under ${manifest.artifacts.dir}.\n`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "up":
      await commandUp(rest);
      break;
    case "status":
      await commandStatus();
      break;
    case "down":
      await commandDown();
      break;
    case "smoke":
      await commandSmoke(rest);
      break;
    default:
      process.stderr.write(
        "Usage: tsx scripts/agent-harness.ts <up|status|down|smoke> [options]\n" +
          "  up [--shadow --scenario <steady|dip|crash> --decision <HOLD|BUY|SELL>]\n" +
          "  smoke --allow-network-smoke\n",
      );
      process.exitCode = command ? 1 : 0;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  /agent-harness(\.ts|\.js)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Harness command failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
}
