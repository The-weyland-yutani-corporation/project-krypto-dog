import { createHash, randomUUID } from "node:crypto";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,126}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const UNSAFE_ID_FRAGMENTS = [
  "://",
  "bearer ",
  "data:",
  "file:",
  "http:",
  "https:",
  "mailto:",
  "password",
  "postgres:",
  "postgresql:",
  "secret",
  "token=",
  "apikey",
  "api_key",
] as const;

export const LOCAL_RELEASE_ID = "local-release";
export const LOCAL_DEPLOYMENT_ID = "local-deployment";

export interface ReleaseDeploymentCorrelation {
  releaseId: string;
  deploymentId: string;
}

function hasUnsafeFragment(value: string): boolean {
  const normalized = value.toLowerCase();
  return UNSAFE_ID_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function isSafeStructuredId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value) && !hasUnsafeFragment(value);
}

export function assertSafeStructuredId(
  value: string,
  fieldName = "correlation ID",
): string {
  if (!isSafeStructuredId(value)) {
    throw new Error(`${fieldName} must be an allowlisted structured identifier`);
  }
  return value;
}

export function generateCorrelationId(
  uuidFactory: () => string = randomUUID,
): string {
  const value = uuidFactory();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("UUID factory returned an invalid correlation ID");
  }
  return value.toLowerCase();
}

/**
 * Accept a caller-provided request ID only when it is a bounded, single-line,
 * allowlisted identifier. Unsafe values are ignored rather than reflected into
 * logs or persistence.
 */
export function resolveRequestId(
  headerValue: string | null | undefined,
  uuidFactory: () => string = randomUUID,
): string {
  const candidate = headerValue?.trim();
  return candidate && isSafeStructuredId(candidate)
    ? candidate
    : generateCorrelationId(uuidFactory);
}

export function requestIdFromHeaders(
  headers: Pick<Headers, "get">,
  uuidFactory: () => string = randomUUID,
): string {
  return resolveRequestId(
    headers.get("x-request-id") ?? headers.get("x-correlation-id"),
    uuidFactory,
  );
}

export function deriveProviderAttemptId(input: {
  requestId: string;
  provider: "acs" | "coinbase" | "foundry" | "posthog";
  attempt: number;
}): string {
  assertSafeStructuredId(input.requestId, "requestId");
  if (
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 ||
    input.attempt > 99
  ) {
    throw new Error("provider attempt must be an integer from 1 through 99");
  }

  const requestHash = createHash("sha256")
    .update(input.requestId, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `attempt-${input.provider}-${input.attempt}-${requestHash}`;
}

function readOptionalEnvironmentValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function resolveReleaseDeploymentCorrelation(
  env: Record<string, string | undefined> = process.env,
): ReleaseDeploymentCorrelation {
  const releaseSha = readOptionalEnvironmentValue(env, "RELEASE_SHA");
  const imageDigest = readOptionalEnvironmentValue(env, "IMAGE_DIGEST");
  const containerRevision = readOptionalEnvironmentValue(
    env,
    "CONTAINER_APP_REVISION",
  );

  if (releaseSha && !RELEASE_SHA_PATTERN.test(releaseSha)) {
    throw new Error("RELEASE_SHA must be a lowercase 40-character Git SHA");
  }
  if (imageDigest && !IMAGE_DIGEST_PATTERN.test(imageDigest)) {
    throw new Error("IMAGE_DIGEST must be a lowercase sha256 digest");
  }
  if (
    containerRevision &&
    (!SAFE_REVISION_PATTERN.test(containerRevision) ||
      hasUnsafeFragment(containerRevision))
  ) {
    throw new Error(
      "CONTAINER_APP_REVISION must be an allowlisted revision identifier",
    );
  }

  const isLocal = env.NODE_ENV !== "production";
  if (!releaseSha && !isLocal) {
    throw new Error("RELEASE_SHA is required outside local execution");
  }
  if (!imageDigest && !containerRevision && !isLocal) {
    throw new Error(
      "IMAGE_DIGEST or CONTAINER_APP_REVISION is required outside local execution",
    );
  }

  let deploymentId = LOCAL_DEPLOYMENT_ID;
  if (containerRevision && imageDigest) {
    const combined = `${containerRevision}.${imageDigest.slice(7, 23)}`;
    deploymentId =
      combined.length <= 128
        ? combined
        : `deployment-${createHash("sha256")
            .update(`${containerRevision}:${imageDigest}`, "utf8")
            .digest("hex")
            .slice(0, 32)}`;
  } else if (containerRevision) {
    deploymentId = containerRevision;
  } else if (imageDigest) {
    deploymentId = imageDigest;
  }

  return {
    releaseId: releaseSha ?? LOCAL_RELEASE_ID,
    deploymentId: assertSafeStructuredId(deploymentId, "deploymentId"),
  };
}
