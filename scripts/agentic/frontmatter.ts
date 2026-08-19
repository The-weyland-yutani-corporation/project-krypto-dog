/**
 * Deterministic GH-AW workflow frontmatter inventory.
 *
 * This module is the single source of truth for enumerating the repository's
 * GH-AW *source* workflows (`.github/workflows/*.md`) and summarizing the
 * inventory fields the agentic-workflows map documents: primary triggers,
 * imported role agents, safe outputs, and AI-credit caps.
 *
 * It is intentionally dependency-light: it parses YAML frontmatter with the
 * direct `yaml` dev dependency and derives everything else from data, never
 * from control flow. Summaries are stable (sorted / canonical order) so the
 * generated documentation and the drift gate are reproducible.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Resolve the repository root portably. These modules run both under `tsx`
 * (ESM, no `__dirname`) and `ts-jest` (CommonJS, no `import.meta`), so we avoid
 * both and walk up from the working directory to the nearest ancestor that
 * looks like this repo. npm scripts and Jest both execute from the package
 * root, so the first candidate normally matches immediately.
 */
function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, ".github", "workflows"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Unable to locate repository root (expected package.json and .github/workflows) from " +
          process.cwd(),
      );
    }
    dir = parent;
  }
}

export const REPO_ROOT = resolveRepoRoot();
export const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

/** Files in the workflows directory that are not GH-AW compiled sources. */
const NON_SOURCE_MARKDOWN = new Set(["AGENTS.md"]);

export interface WorkflowInventory {
  /** Source basename, e.g. `pm-triage`. */
  id: string;
  /** Repo-relative source path, e.g. `.github/workflows/pm-triage.md`. */
  sourcePath: string;
  /** Repo-relative compiled lock path, e.g. `.github/workflows/pm-triage.lock.yml`. */
  lockPath: string;
  /** Imported role-agent basenames, or `["Built-in prompt"]` when none. */
  imports: string[];
  /** Canonical, human-readable primary-trigger summary tokens. */
  triggers: string[];
  /** Sorted safe-output kinds declared in `safe-outputs`. */
  safeOutputs: string[];
  /** AI-credit caps as `{ perRun, perDay }`; either may be null when unset. */
  creditCaps: { perRun: number | null; perDay: number | null };
}

/** Raw parsed frontmatter shape (only the fields we read). */
interface Frontmatter {
  on?: Record<string, unknown> | string;
  imports?: unknown;
  "safe-outputs"?: Record<string, unknown>;
  "max-ai-credits"?: unknown;
  "max-daily-ai-credits"?: unknown;
}

/**
 * Split a workflow markdown file into its YAML frontmatter block and body.
 * Throws (fail loud) when the file does not open with a `---` fence.
 */
export function splitFrontmatter(source: string, label: string): {
  frontmatter: string;
  body: string;
} {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    throw new Error(`${label}: missing opening \`---\` frontmatter fence`);
  }
  const rest = source.slice(source.indexOf("\n") + 1);
  const closeMatch = rest.match(/^---[ \t]*(?:\r?\n|$)/m);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new Error(`${label}: unterminated frontmatter block`);
  }
  return {
    frontmatter: rest.slice(0, closeMatch.index),
    body: rest.slice(closeMatch.index + closeMatch[0].length),
  };
}

/** List GH-AW source workflow basenames, sorted for determinism. */
export function listSourceWorkflowIds(): string[] {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".md") && !NON_SOURCE_MARKDOWN.has(name))
    .map((name) => name.slice(0, -".md".length))
    .sort((a, b) => a.localeCompare(b, "en"));
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function summarizeImports(frontmatter: Frontmatter): string[] {
  const imports = asArray(frontmatter.imports)
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => path.basename(entry))
    .sort((a, b) => a.localeCompare(b, "en"));
  return imports.length > 0 ? imports : ["Built-in prompt"];
}

function validateImports(frontmatter: Frontmatter, sourcePath: string): void {
  for (const entry of asArray(frontmatter.imports)) {
    if (typeof entry !== "string") {
      throw new Error(
        `${sourcePath}: every \`imports\` entry must be a repository-relative path. ` +
          "Fix the frontmatter, then run `npm run harness:check`.",
      );
    }
    const absolute = path.resolve(REPO_ROOT, entry);
    const relative = path.relative(REPO_ROOT, absolute);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !fs.existsSync(absolute)
    ) {
      throw new Error(
        `${sourcePath}: imported agent does not exist: ${entry}. ` +
          "Fix the path, then run `npm run harness:check`.",
      );
    }
  }
}

/**
 * Top-level keys under `safe-outputs` that configure behavior rather than
 * declare an output kind. These are excluded from the inventory so knobs like
 * `max-patch-files: 20` are never mistaken for a safe output.
 */
const SAFE_OUTPUT_CONFIG_KEYS = new Set([
  "allowed-domains",
  "env",
  "github-token",
  "max-patch-files",
  "max-patch-size",
  "messages",
  "runs-on",
  "staged",
  "threat-detection",
]);

function summarizeSafeOutputs(frontmatter: Frontmatter): string[] {
  const safeOutputs = frontmatter["safe-outputs"];
  if (!safeOutputs || typeof safeOutputs !== "object") {
    return [];
  }
  return Object.entries(safeOutputs)
    .filter(([key, value]) => {
      if (SAFE_OUTPUT_CONFIG_KEYS.has(key)) return false;
      // Output kinds are declared as a mapping (their config) or an empty
      // value; scalar knobs (numbers/strings/booleans) are configuration.
      const isMapping =
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);
      return value === null || isMapping;
    })
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b, "en"));
}

function coerceCap(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Summarize `on:` into canonical, deterministic trigger tokens. The order is
 * fixed (manual, schedule, slash command, label, issue, PR, workflow_run) so
 * regenerating the docs never reshuffles rows.
 */
function summarizeTriggers(frontmatter: Frontmatter): string[] {
  const on = frontmatter.on;
  const tokens: string[] = [];
  if (typeof on === "string") {
    return [on];
  }
  if (!on || typeof on !== "object") {
    return [];
  }

  if ("workflow_dispatch" in on) {
    tokens.push("manual");
  }
  if ("schedule" in on) {
    const schedule = on.schedule;
    tokens.push(
      typeof schedule === "string"
        ? `schedule: ${schedule}`
        : "schedule",
    );
  }
  if ("slash_command" in on) {
    const command = on.slash_command as { name?: unknown } | undefined;
    const name =
      command && typeof command.name === "string" ? command.name : "command";
    tokens.push(`/${name}`);
  }

  const issues = on.issues as
    | { types?: unknown; names?: unknown }
    | undefined;
  if (issues && typeof issues === "object") {
    const names = asArray(issues.names)
      .filter((n): n is string => typeof n === "string")
      .sort((a, b) => a.localeCompare(b, "en"));
    if (names.length > 0) {
      tokens.push(`issue label: ${names.join(", ")}`);
    } else {
      const types = asArray(issues.types)
        .filter((t): t is string => typeof t === "string")
        .sort((a, b) => a.localeCompare(b, "en"));
      tokens.push(
        types.length > 0 ? `issue: ${types.join(", ")}` : "issue",
      );
    }
  }

  const pull = on.pull_request as { types?: unknown; paths?: unknown } | undefined;
  if (pull && typeof pull === "object") {
    const types = asArray(pull.types)
      .filter((t): t is string => typeof t === "string")
      .sort((a, b) => a.localeCompare(b, "en"));
    const scoped = asArray(pull.paths).length > 0 ? " (path-scoped)" : "";
    tokens.push(
      types.length > 0 ? `PR: ${types.join(", ")}${scoped}` : `PR${scoped}`,
    );
  }

  const run = on.workflow_run as { workflows?: unknown } | undefined;
  if (run && typeof run === "object") {
    const workflows = asArray(run.workflows)
      .filter((w): w is string => typeof w === "string")
      .sort((a, b) => a.localeCompare(b, "en"));
    tokens.push(
      workflows.length > 0
        ? `workflow_run: ${workflows.join(", ")}`
        : "workflow_run",
    );
  }

  return tokens;
}

/** Build the inventory for a single source workflow id. */
export function inventoryForWorkflow(id: string): WorkflowInventory {
  const sourcePath = path.join(WORKFLOWS_DIR, `${id}.md`);
  const rel = path.relative(REPO_ROOT, sourcePath);
  const raw = fs.readFileSync(sourcePath, "utf8");
  const { frontmatter: block } = splitFrontmatter(raw, rel);

  let parsed: Frontmatter;
  try {
    parsed = (parseYaml(block) ?? {}) as Frontmatter;
  } catch (error) {
    throw new Error(
      `${rel}: invalid YAML frontmatter: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${rel}: frontmatter must be a mapping`);
  }
  validateImports(parsed, rel);

  return {
    id,
    sourcePath: rel,
    lockPath: path.relative(
      REPO_ROOT,
      path.join(WORKFLOWS_DIR, `${id}.lock.yml`),
    ),
    imports: summarizeImports(parsed),
    triggers: summarizeTriggers(parsed),
    safeOutputs: summarizeSafeOutputs(parsed),
    creditCaps: {
      perRun: coerceCap(parsed["max-ai-credits"]),
      perDay: coerceCap(parsed["max-daily-ai-credits"]),
    },
  };
}

/** Build the full, sorted inventory for every source workflow. */
export function buildWorkflowInventory(): WorkflowInventory[] {
  return listSourceWorkflowIds().map(inventoryForWorkflow);
}
