import { isIP } from "node:net";

const TARGET_OVERRIDE_PARAMETERS = new Set([
  "host",
  "hostaddr",
  "service",
  "servicefile",
]);

/**
 * Returns true only for an unambiguous loopback hostname. The strict spelling
 * rules deliberately reject shortened/numeric IPv4 forms and DNS names that
 * merely contain "localhost".
 */
export function isLoopbackPostgresHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");

  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  if (isIP(normalized) !== 4) {
    return false;
  }

  return normalized.split(".")[0] === "127";
}

/**
 * Parses a PostgreSQL connection URL and accepts it only when it targets an
 * explicit loopback host. Invalid URLs, non-PostgreSQL protocols, socket/query
 * host overrides, and every remote hostname fail closed.
 */
export function isLoopbackPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      return false;
    }
    if (
      !url.hostname ||
      [...url.searchParams.keys()].some((key) =>
        TARGET_OVERRIDE_PARAMETERS.has(key.toLowerCase()),
      )
    ) {
      return false;
    }
    return isLoopbackPostgresHostname(url.hostname);
  } catch {
    return false;
  }
}
