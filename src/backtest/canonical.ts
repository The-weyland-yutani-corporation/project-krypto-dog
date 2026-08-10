import { createHash } from "node:crypto";

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function normalizeCanonicalValue(
  value: unknown,
  path: string,
): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Canonical JSON value at ${path} must be finite`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeCanonicalValue(entry, `${path}[${index}]`),
    );
  }
  if (typeof value === "object") {
    const normalized: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) {
        throw new Error(
          `Canonical JSON value at ${path}.${key} must not be undefined`,
        );
      }
      normalized[key] = normalizeCanonicalValue(
        entry,
        `${path}.${key}`,
      );
    }
    return normalized;
  }
  throw new Error(
    `Canonical JSON value at ${path} uses unsupported type ${typeof value}`,
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value, "$"));
}

export function stablePrettyJson(value: unknown): string {
  return `${JSON.stringify(normalizeCanonicalValue(value, "$"), null, 2)}\n`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}
