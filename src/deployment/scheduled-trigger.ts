#!/usr/bin/env node
import { createHash } from "node:crypto";
// Azure Container Apps Jobs scheduled HTTP trigger for Project Krypto.
//
// This module is intentionally dependency-free (Node built-ins and the
// global `fetch` only) so it can run standalone — both as an importable
// module for tests and as a CLI entry point via
//
//   node --experimental-strip-types src/deployment/scheduled-trigger.ts
//
// — inside the minimal `web` Docker image, without pulling in Next.js,
// Drizzle, or any other project dependency, and without relying on a
// relative cross-file import (Node's ESM resolver requires explicit file
// extensions for relative specifiers, which conflicts with this repo's
// shared `moduleResolution: "bundler"` tsconfig used for typecheck; keeping
// everything in one file sidesteps that without changing shared tsconfig).
// Keep it that way: do not import from elsewhere in `src/`.
//
// It fires a single bounded HTTP request at one of the two allowed scheduled
// routes (`/api/agent/run`, `/api/agent/daily-summary`), authenticates with
// the shared cron secret, asserts the expected rollout mode, and — for
// agent runs only — attaches a stable per-UTC-hour idempotency key so a
// re-delivered trigger within the same hour lands on the same AgentRun row
// instead of starting a second one.
//
// Retries are deliberately out of scope here. Both scheduler jobs use
// replicaRetryLimit=0; invocation idempotency remains defense in depth rather
// than a reason to extend the bounded execution chain. This module performs
// exactly one attempt and reports success or failure via its return value /
// thrown error so the caller's process exit code reflects the outcome.
//
// Required environment variables when run as a CLI: TARGET_BASE_URL,
// SCHEDULED_ROUTE, CRON_SECRET, ROLLOUT_MODE (see validators below). An
// attended manual shadow proof may additionally supply a unique
// SCHEDULED_IDEMPOTENCY_KEY. Exits 0 on a 2xx response, 1 otherwise. Never
// logs CRON_SECRET or any other secret value.

export type ScheduledRouteName = "/api/agent/run" | "/api/agent/daily-summary";

const ALLOWED_ROUTES: readonly ScheduledRouteName[] = [
  "/api/agent/run",
  "/api/agent/daily-summary",
];

export type RolloutMode = "disabled" | "shadow" | "paper";

const ALLOWED_ROLLOUT_MODES: readonly RolloutMode[] = [
  "disabled",
  "shadow",
  "paper",
];

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const SCHEDULED_HTTP_TIMEOUT_MS = 210_000;

export class ScheduledTriggerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledTriggerConfigError";
  }
}

export class ScheduledTriggerRequestError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ScheduledTriggerRequestError";
    this.status = status;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Validates TARGET_BASE_URL: must be a bare origin — an absolute http(s) URL
 * with no credentials, path (other than `/` or empty), query, or fragment —
 * and must use HTTPS unless the host is an explicit loopback test target
 * (localhost/127.0.0.1/::1). SCHEDULED_ROUTE supplies the path separately,
 * matching the same bare-origin binding convention used by
 * src/deployment/target-smoke.ts's validateTargetBaseUrl.
 */
export function validateTargetBaseUrl(value: string | undefined): URL {
  if (!value || value.trim() === "") {
    throw new ScheduledTriggerConfigError(
      "TARGET_BASE_URL is required and must be a non-empty absolute URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ScheduledTriggerConfigError(
      "TARGET_BASE_URL must be a valid absolute URL.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ScheduledTriggerConfigError(
      "TARGET_BASE_URL must use HTTP or HTTPS.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new ScheduledTriggerConfigError(
      "TARGET_BASE_URL must be a bare origin: no credentials, path, query, or fragment (SCHEDULED_ROUTE supplies the path).",
    );
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new ScheduledTriggerConfigError(
      "TARGET_BASE_URL must use HTTPS unless it is an explicit loopback test target (localhost/127.0.0.1/::1).",
    );
  }
  return url;
}

/** Validates SCHEDULED_ROUTE: must be exactly one of the two allowed routes. */
export function validateScheduledRoute(
  value: string | undefined,
): ScheduledRouteName {
  if (!value || !(ALLOWED_ROUTES as readonly string[]).includes(value)) {
    throw new ScheduledTriggerConfigError(
      `SCHEDULED_ROUTE must be one of: ${ALLOWED_ROUTES.join(", ")}.`,
    );
  }
  return value as ScheduledRouteName;
}

/** Validates CRON_SECRET: must be present and non-empty. Never logged. */
export function validateCronSecret(value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new ScheduledTriggerConfigError(
      "CRON_SECRET is required and must be a non-empty string.",
    );
  }
  return value;
}

/** Validates ROLLOUT_MODE: must be one of disabled/shadow/paper (case-insensitive). */
export function validateRolloutMode(value: string | undefined): RolloutMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!(ALLOWED_ROLLOUT_MODES as readonly string[]).includes(normalized)) {
    throw new ScheduledTriggerConfigError(
      `ROLLOUT_MODE must be one of: ${ALLOWED_ROLLOUT_MODES.join(", ")}.`,
    );
  }
  return normalized as RolloutMode;
}

export function validateScheduledIdempotencyKey(
  value: string | undefined,
  route: ScheduledRouteName,
  rolloutMode: RolloutMode,
): string | undefined {
  if (!value) return undefined;
  if (route !== "/api/agent/run") {
    throw new ScheduledTriggerConfigError(
      "SCHEDULED_IDEMPOTENCY_KEY is allowed only for /api/agent/run.",
    );
  }
  if (!/^manual-shadow:[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new ScheduledTriggerConfigError(
      "SCHEDULED_IDEMPOTENCY_KEY must be a manual-shadow: prefix followed by 1-64 safe characters.",
    );
  }
  if (rolloutMode !== "shadow") {
    throw new ScheduledTriggerConfigError(
      "A manual-shadow SCHEDULED_IDEMPOTENCY_KEY requires ROLLOUT_MODE=shadow.",
    );
  }
  return value;
}

export function validateScheduledIdempotencyNamespace(
  value: string | undefined,
  route: ScheduledRouteName,
): string | undefined {
  if (!value) return undefined;
  if (route !== "/api/agent/run") {
    throw new ScheduledTriggerConfigError(
      "SCHEDULED_IDEMPOTENCY_NAMESPACE is allowed only for /api/agent/run.",
    );
  }
  if (!/^sha256:[a-f0-9]{64}-[0-9]{1,10}$/.test(value)) {
    throw new ScheduledTriggerConfigError(
      "SCHEDULED_IDEMPOTENCY_NAMESPACE must bind a sha256 image digest to a numeric activation generation.",
    );
  }
  return value;
}

export interface ScheduledTriggerEnv {
  TARGET_BASE_URL?: string;
  SCHEDULED_ROUTE?: string;
  CRON_SECRET?: string;
  ROLLOUT_MODE?: string;
  SCHEDULED_IDEMPOTENCY_KEY?: string;
  SCHEDULED_IDEMPOTENCY_NAMESPACE?: string;
  // Index signature (rather than only the four named optional properties
  // above) so `process.env` — a dictionary type with no properties known to
  // overlap structurally — remains assignable here without a cast.
  [key: string]: string | undefined;
}

export interface ScheduledTriggerConfig {
  targetUrl: URL;
  route: ScheduledRouteName;
  cronSecret: string;
  rolloutMode: RolloutMode;
  explicitIdempotencyKey: string | undefined;
  idempotencyNamespace: string | undefined;
}

/** Validates all four required inputs and returns a resolved configuration. */
export function resolveScheduledTriggerConfig(
  env: ScheduledTriggerEnv,
): ScheduledTriggerConfig {
  const route = validateScheduledRoute(env.SCHEDULED_ROUTE);
  const rolloutMode = validateRolloutMode(env.ROLLOUT_MODE);
  return {
    targetUrl: validateTargetBaseUrl(env.TARGET_BASE_URL),
    route,
    cronSecret: validateCronSecret(env.CRON_SECRET),
    rolloutMode,
    explicitIdempotencyKey: validateScheduledIdempotencyKey(
      env.SCHEDULED_IDEMPOTENCY_KEY,
      route,
      rolloutMode,
    ),
    idempotencyNamespace: validateScheduledIdempotencyNamespace(
      env.SCHEDULED_IDEMPOTENCY_NAMESPACE,
      route,
    ),
  };
}

/**
 * A stable UTC-hour idempotency key for agent runs only (daily-summary has
 * no idempotency key column and takes no retry). Two trigger invocations
 * within the same UTC hour produce the identical key so a re-delivered
 * trigger converges on the same AgentRun row instead of starting a new run.
 */
export function buildIdempotencyKey(
  route: ScheduledRouteName,
  now: Date,
  explicitKey?: string,
  namespace?: string,
): string | undefined {
  if (route !== "/api/agent/run") return undefined;
  if (explicitKey) return explicitKey;
  // Matches the server-side default format in src/agent/run-flow.ts
  // (defaultIdempotencyKey) so scheduled and unscheduled cron triggers within
  // the same hour always converge on one AgentRun row.
  const hour = now.toISOString().slice(0, 13);
  return namespace ? `cron:${namespace}:${hour}` : `cron:${hour}`;
}

export function buildScheduledRequestId(
  route: ScheduledRouteName,
  now: Date,
  idempotencyKey?: string,
): string {
  const logicalSlot =
    route === "/api/agent/run"
      ? now.toISOString().slice(0, 13)
      : now.toISOString().slice(0, 10);
  const digest = createHash("sha256")
    .update(`${route}\n${idempotencyKey ?? logicalSlot}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `scheduled-${digest}`;
}

export interface ScheduledTriggerOutcome {
  route: ScheduledRouteName;
  requestUrl: string;
  status: number;
  idempotencyKey: string | undefined;
  durationMs: number;
}

export interface RunScheduledTriggerOptions {
  env: ScheduledTriggerEnv;
  now?: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fires exactly one bounded HTTP POST at the configured scheduled route.
 * Throws ScheduledTriggerConfigError for invalid input, or
 * ScheduledTriggerRequestError for a network failure or non-2xx response.
 * Never includes CRON_SECRET (or any other secret) in a thrown message.
 */
export async function runScheduledTrigger(
  options: RunScheduledTriggerOptions,
): Promise<ScheduledTriggerOutcome> {
  const config = resolveScheduledTriggerConfig(options.env);
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SCHEDULED_HTTP_TIMEOUT_MS;

  const requestUrl = new URL(config.route, config.targetUrl);
  const idempotencyKey = buildIdempotencyKey(
    config.route,
    now,
    config.explicitIdempotencyKey,
    config.idempotencyNamespace,
  );

  const headers: Record<string, string> = {
    "x-cron-secret": config.cronSecret,
    "x-required-rollout-mode": config.rolloutMode,
    "x-request-id": buildScheduledRequestId(
      config.route,
      now,
      idempotencyKey,
    ),
  };
  if (idempotencyKey) {
    headers["x-idempotency-key"] = idempotencyKey;
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown error";
    throw new ScheduledTriggerRequestError(
      `Scheduled trigger request to ${config.route} failed before a response was received (${reason}).`,
    );
  }
  const durationMs = Date.now() - startedAt;

  if (response.status < 200 || response.status >= 300) {
    throw new ScheduledTriggerRequestError(
      `Scheduled trigger for ${config.route} received a non-2xx response (status ${response.status}).`,
      response.status,
    );
  }

  return {
    route: config.route,
    requestUrl: requestUrl.toString(),
    status: response.status,
    idempotencyKey,
    durationMs,
  };
}

/**
 * CLI entry point, invoked by scripts/scheduled-trigger.mjs. Kept separate
 * from that bootstrap file (rather than using an `import.meta`-based
 * self-execution guard here) because a literal `import.meta` token makes
 * this file unparseable under this repo's CommonJS-mode Jest transform —
 * this function has no import.meta/module-system dependency and stays
 * fully testable and side-effect-free on import.
 */
export async function main(): Promise<void> {
  try {
    const outcome = await runScheduledTrigger({ env: process.env });
    const idempotencySuffix = outcome.idempotencyKey
      ? ` idempotencyKey=${outcome.idempotencyKey}`
      : "";
    console.log(
      `[scheduled-trigger] ok route=${outcome.route} status=${outcome.status} durationMs=${outcome.durationMs}${idempotencySuffix}`,
    );
  } catch (error) {
    if (error instanceof ScheduledTriggerConfigError) {
      console.error(`[scheduled-trigger] configuration error: ${error.message}`);
    } else if (error instanceof ScheduledTriggerRequestError) {
      console.error(`[scheduled-trigger] request failure: ${error.message}`);
    } else {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`[scheduled-trigger] unexpected failure: ${message}`);
    }
    process.exitCode = 1;
  }
}
