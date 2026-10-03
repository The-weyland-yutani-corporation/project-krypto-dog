import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const RETIRED_ROOT = path.join(ROOT, "supabase");
const THIS_TEST = "tests/repository/retired-supabase-surface.test.ts";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "coverage",
  "deployment-evidence",
  "node_modules",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".example",
  ".gitignore",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const TEXT_BASENAMES = new Set([
  ".dockerignore",
  "CODEOWNERS",
  "Dockerfile",
]);

const HISTORICAL_PREFIXES = [
  "tests/fixtures/legacy-supabase-cron/",
];

const IMMUTABLE_HISTORY_FILES = new Set([
  "drizzle/0007_azure_retire_supabase_http_functions.sql",
  "drizzle/meta/_journal.json",
]);

// These files intentionally retain conservative path tombstones so deletion of
// a retired path can never bypass routing, review, or destructive-SQL checks.
const GOVERNANCE_TOMBSTONES = new Set([
  ".github/CODEOWNERS",
  ".github/agentic-policy.json",
  ".github/agents/project-krypto-dev.md",
  ".github/scripts/agentic-factory-policy.cjs",
  ".github/skills/project-krypto-factory/SKILL.md",
  ".github/workflows/pr-self-heal.lock.yml",
  ".github/workflows/pr-self-heal.md",
  ".github/workflows/trading-safety-review.lock.yml",
  ".github/workflows/trading-safety-review.md",
  "docs/agentic-workflows-map.md",
  "evals/agentic-sdlc/fixtures/specialist-routing.json",
  "specs/governance.md",
  "tests/agentic-sdlc/agentic-policy.test.ts",
  "tests/agentic-sdlc/factory-policy.test.ts",
]);

const TEST_ASSERTION_FILES = new Set([
  THIS_TEST,
  "tests/db/migration-safety.test.ts",
]);

const LEGACY_FIXTURE_REFERENCE_FILES = new Set([
  THIS_TEST,
  "scripts/test-migrations.sh",
  "tests/db/migration-safety.test.ts",
]);

const ALLOWED_ACTIVE_REFERENCES = [
  /drizzle\/0007_azure_retire_supabase_http_functions\.sql/giu,
];
const LEGACY_FIXTURE_PATH = /tests\/fixtures\/legacy-supabase-cron/giu;
const GOVERNANCE_PATH_REFERENCE =
  /supabase\/migrations(?:\/(?:\*\*|[A-Za-z0-9._*-]+))?\/?/giu;
const GOVERNANCE_ONLY_REFERENCES = [
  /supabase\/config\.toml/giu,
  /\b(?:Drizzle\/)?Supabase migrations\b/giu,
];

const FORBIDDEN_ACTIVE_SURFACES = [
  {
    label: "Supabase CLI command",
    pattern:
      /(?:^|[^\w])(?:npx\s+(?:--yes\s+)?|npm\s+exec\s+)?supabase(?:@\S+)?\s+(?:start|stop|status|link|login|db|functions|migration|secrets|projects|config)\b/iu,
  },
  {
    label: "Supabase environment variable",
    pattern: /\bSUPABASE_[A-Z0-9_]+\b/u,
  },
  {
    label: "Supabase service URL",
    pattern:
      /(?:https?|postgres(?:ql)?):\/\/[^\s"'`]*supabase\.(?:co|com)\b/iu,
  },
  {
    label: "retired root project path",
    pattern: /\bsupabase\/(?:config\.toml|operations\/|migrations\/)/iu,
  },
  {
    label: "deployment provider selector",
    pattern: /--provider(?:\s+|=)(?:azure|supabase)\b/iu,
  },
  {
    label: "deployment provider environment selector",
    pattern: /\bDEPLOYMENT_PROVIDER\b/u,
  },
];

function listTextFiles(
  directory: string,
  relativeDirectory = "",
): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return IGNORED_DIRECTORIES.has(entry.name)
          ? []
          : listTextFiles(absolutePath, relativePath);
      }

      if (
        !entry.isFile() ||
        (!TEXT_EXTENSIONS.has(path.extname(entry.name)) &&
          !TEXT_BASENAMES.has(entry.name))
      ) {
        return [];
      }

      return [relativePath];
    });
}

function isAllowlistedContext(relativePath: string): boolean {
  return (
    HISTORICAL_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) ||
    IMMUTABLE_HISTORY_FILES.has(relativePath) ||
    TEST_ASSERTION_FILES.has(relativePath)
  );
}

function stripAllowedReferences(
  relativePath: string,
  source: string,
): string {
  let content = source;
  for (const allowedReference of ALLOWED_ACTIVE_REFERENCES) {
    content = content.replace(allowedReference, "");
  }
  if (LEGACY_FIXTURE_REFERENCE_FILES.has(relativePath)) {
    content = content.replace(LEGACY_FIXTURE_PATH, "");
  }
  if (GOVERNANCE_TOMBSTONES.has(relativePath)) {
    content = content.replaceAll("\\/", "/").replaceAll("\\.", ".");
    content = content.replace(GOVERNANCE_PATH_REFERENCE, "");
    for (const governanceReference of GOVERNANCE_ONLY_REFERENCES) {
      content = content.replace(governanceReference, "");
    }
  }
  return content;
}

describe("retired Supabase repository surface", () => {
  const textFiles = listTextFiles(ROOT);

  test("has no root Supabase project or deployable operation path", () => {
    expect(fs.existsSync(RETIRED_ROOT)).toBe(false);
    expect(textFiles.filter((file) => file.startsWith("supabase/"))).toEqual(
      [],
    );
  });

  test("keeps executable legacy cron SQL only in explicit fixture files", () => {
    const schedulerSqlFiles = textFiles
      .filter((file) => file.endsWith(".sql"))
      .filter((file) =>
        /\bcron\.(?:schedule|unschedule)\s*\(/iu.test(
          fs.readFileSync(path.join(ROOT, file), "utf8"),
        ),
      )
      .sort();

    expect(schedulerSqlFiles).toEqual([
      "tests/fixtures/legacy-supabase-cron/disable-krypto-cron.fixture.sql",
      "tests/fixtures/legacy-supabase-cron/enable-krypto-cron.fixture.sql",
    ]);
  });

  test("allows legacy fixture references only from migration-test callers", () => {
    const references = textFiles
      .filter((relativePath) =>
        fs
          .readFileSync(path.join(ROOT, relativePath), "utf8")
          .includes("tests/fixtures/legacy-supabase-cron"),
      )
      .sort();

    expect(references).toEqual([...LEGACY_FIXTURE_REFERENCE_FILES].sort());
  });

  test("has no active CLI, environment, URL, or provider-selection surface", () => {
    const findings: string[] = [];

    for (const relativePath of textFiles) {
      if (isAllowlistedContext(relativePath)) {
        continue;
      }

      const content = stripAllowedReferences(
        relativePath,
        fs.readFileSync(path.join(ROOT, relativePath), "utf8"),
      );
      for (const { label, pattern } of FORBIDDEN_ACTIVE_SURFACES) {
        if (pattern.test(content)) {
          findings.push(`${relativePath}: ${label}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  test("allows only explicit historical, fixture, or migration references in active text", () => {
    const findings: string[] = [];

    for (const relativePath of textFiles) {
      if (isAllowlistedContext(relativePath)) {
        continue;
      }

      const content = stripAllowedReferences(
        relativePath,
        fs.readFileSync(path.join(ROOT, relativePath), "utf8"),
      );

      if (/supabase/iu.test(content)) {
        findings.push(relativePath);
      }
    }

    expect(findings).toEqual([]);
  });
});
