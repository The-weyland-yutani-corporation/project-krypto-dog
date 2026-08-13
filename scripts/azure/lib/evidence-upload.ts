import { runCli } from "./run-cli";

export type EvidenceUploadInput = {
  /** The full local per-execution report directory (uploaded recursively). */
  reportDirectory: string;
  /** A bare HTTPS container URL -- no credentials, query, or fragment. */
  containerUrl: string;
  /**
   * The validated, immutable `ENVIRONMENT_NAME/RELEASE_SHA/OPERATION/JOB_EXECUTION_ID`
   * destination prefix (see `deriveEvidenceDestinationPrefix`).
   */
  destinationPrefix: string;
  /**
   * The client ID (GUID) of the user-assigned managed identity the ops
   * job runs as. Ops jobs are provisioned with a user-assigned identity
   * only (no system-assigned identity is available), so this must be
   * supplied explicitly on every invocation -- it is not a secret, but it
   * is required and validated so an unconfigured or wrong-identity
   * environment fails closed rather than silently attempting (and
   * failing, or worse, succeeding against the wrong identity) a
   * system-assigned login.
   */
  msiClientId: string;
};

const DESTINATION_PREFIX_SEGMENT = "[A-Za-z0-9][A-Za-z0-9_.-]*";
const DESTINATION_PREFIX_PATTERN = new RegExp(
  `^${DESTINATION_PREFIX_SEGMENT}(?:/${DESTINATION_PREFIX_SEGMENT}){3}$`,
);

function validateDestinationPrefix(value: string): string {
  if (!DESTINATION_PREFIX_PATTERN.test(value) || value.includes("..")) {
    throw new Error(
      "Evidence destination prefix must be exactly ENVIRONMENT_NAME/RELEASE_SHA/OPERATION/JOB_EXECUTION_ID.",
    );
  }
  return value;
}

const GUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Validates the user-assigned managed identity client ID. This value is
 * not a secret (it is a stable, non-sensitive GUID identifying which
 * identity to authenticate as), but it is required and must be a
 * well-formed GUID -- a missing or malformed value must never fall back
 * to an implicit/system-assigned identity lookup.
 */
export function validateMsiClientId(value: string): string {
  if (!value) {
    throw new Error(
      "AZCOPY_MSI_CLIENT_ID is required for evidence upload (ops jobs authenticate with a user-assigned managed identity only).",
    );
  }
  if (!GUID_PATTERN.test(value)) {
    throw new Error(
      "AZCOPY_MSI_CLIENT_ID must be a valid GUID (the user-assigned managed identity's client ID).",
    );
  }
  return value;
}

/**
 * Validates that the evidence container URL is a bare HTTPS container
 * location -- authentication is via managed identity only, so a
 * credential, SAS query string, or fragment must never be present or
 * relied upon.
 */
function validateContainerUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("EVIDENCE_CONTAINER_URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "EVIDENCE_CONTAINER_URL must be a bare container URL with no credentials, query string, or fragment -- authentication is managed identity only.",
    );
  }
  return url;
}

function redactedContainerLocation(containerUrl: string): string {
  try {
    const url = new URL(containerUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[unparseable-container-url]";
  }
}

/**
 * Uploads the entire per-execution report directory -- recursively,
 * including nested backup archive/checksum files and the manifest -- to a
 * validated, immutable destination prefix under `EVIDENCE_CONTAINER_URL`,
 * authenticating as a user-assigned managed identity. Called for both
 * passing and failing operation outcomes -- a failed report is an audit
 * record and must never be dropped -- the caller distinguishes pass from
 * fail via the uploaded report's own contents, not by skipping the
 * upload.
 *
 * Authentication is AzCopy's in-process MSI auto-login, scoped to the
 * single `azcopy copy` invocation via `AZCOPY_AUTO_LOGIN_TYPE=MSI` and
 * `AZCOPY_MSI_CLIENT_ID` in that child process's environment only. There
 * is deliberately no separate `azcopy login` step and no persistent
 * on-disk token cache: ops jobs run with a user-assigned identity only
 * (no system-assigned identity exists to authenticate a bare `azcopy
 * login --identity`), and relying on a cross-process login/cache would
 * both target the wrong identity and leave stale credential state behind
 * between per-execution job invocations.
 *
 * Never logs the full container URL or any credential -- error messages
 * only ever include the redacted `scheme://host/path` location, never a
 * query string (which could carry a SAS token) and never the local
 * report's contents. `--overwrite=false` is always used so a destination
 * can never be silently clobbered.
 */
export async function uploadEvidence(
  input: EvidenceUploadInput,
): Promise<void> {
  if (!input.containerUrl) {
    throw new Error(
      "EVIDENCE_CONTAINER_URL is required for evidence upload.",
    );
  }
  const containerUrl = validateContainerUrl(input.containerUrl);
  const destinationPrefix = validateDestinationPrefix(input.destinationPrefix);
  const msiClientId = validateMsiClientId(input.msiClientId);

  const destination = new URL(containerUrl.toString());
  destination.pathname = `${destination.pathname.replace(/\/$/, "")}/${destinationPrefix}`;

  const sourceGlob = `${input.reportDirectory.replace(/\/$/, "")}/*`;
  const copy = await runCli(
    "azcopy",
    [
      "copy",
      sourceGlob,
      destination.toString(),
      "--recursive=true",
      "--overwrite=false",
    ],
    {
      ...process.env,
      AZCOPY_AUTO_LOGIN_TYPE: "MSI",
      AZCOPY_MSI_CLIENT_ID: msiClientId,
    },
  );
  if (copy.exitCode !== 0) {
    throw new Error(
      `Evidence upload to ${redactedContainerLocation(input.containerUrl)} failed with exit code ${copy.exitCode}.`,
    );
  }
}
