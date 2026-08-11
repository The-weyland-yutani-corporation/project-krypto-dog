import path from "node:path";
import { parse as parseYaml } from "yaml";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function normalizedGeneratedValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const action = value.match(
      /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(?:[0-9a-f]{40}|v?\d[^@\s]*)$/i,
    );
    if (action) return action[1];
    return value.replace(/@sha256:[0-9a-f]{64}$/i, "");
  }
  if (Array.isArray(value)) {
    return value.map(normalizedGeneratedValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalizedGeneratedValue(entry),
      ]),
    );
  }
  return String(value);
}

function commentPayload(text: string, prefix: string): Record<string, unknown> | null {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith(prefix));
  if (!line) return null;
  try {
    return JSON.parse(line.trim().slice(prefix.length).trim()) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export function generatedArtifactSignature(
  relativePath: string,
  text: string,
): string {
  const name = path.basename(relativePath);

  if (name.endsWith(".lock.yml")) {
    const metadata = commentPayload(text, "# gh-aw-metadata:");
    if (!metadata) return "";
    return stableStringify({
      kind: "workflow-lock",
      schemaVersion: normalizedGeneratedValue(
        metadata.schema_version ?? null,
      ),
      frontmatterHash: normalizedGeneratedValue(
        metadata.frontmatter_hash ?? null,
      ),
      bodyHash: normalizedGeneratedValue(metadata.body_hash ?? null),
      compilerVersion: normalizedGeneratedValue(
        metadata.compiler_version ?? null,
      ),
      strict: normalizedGeneratedValue(metadata.strict ?? null),
      agentId: normalizedGeneratedValue(metadata.agent_id ?? null),
    });
  }

  if (name === "agentic_commands.yml") {
    const commands = commentPayload(text, "# gh-aw-commands:");
    return commands
      ? stableStringify({
          kind: "command-router",
          payload: normalizedGeneratedValue(commands),
        })
      : "";
  }

  if (name === "agentics-maintenance.yml") {
    try {
      return stableStringify({
        kind: "maintenance",
        workflow: normalizedGeneratedValue(parseYaml(text)),
      });
    } catch {
      return "";
    }
  }

  return "";
}
