/**
 * Validate local Markdown file and anchor references across the agentic
 * documentation and instruction surfaces.
 *
 * For every relative Markdown link:
 *   - the target file must exist (resolved relative to the linking document);
 *   - when the target is a Markdown file and the link carries a `#anchor`, the
 *     anchor must match a GitHub-style heading slug in that file;
 *   - a bare `#anchor` link must resolve within the linking document.
 *
 * External links (`http`, `https`, `mailto`) are ignored. Fenced code blocks
 * are stripped before scanning so sample snippets never produce false links.
 *
 * Usage: tsx scripts/check-markdown-links.ts
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./agentic/frontmatter";

const REMEDIATION =
  "fix or remove the broken reference in the owning file, then rerun `npm run agentic:links`";

/** Deterministically discover the documentation/instruction surfaces to check. */
function discoverDocs(): string[] {
  const docs = new Set<string>();

  const addIfExists = (rel: string): void => {
    if (fs.existsSync(path.join(REPO_ROOT, rel))) docs.add(rel);
  };
  const addTree = (relDir: string): void => {
    const abs = path.join(REPO_ROOT, relDir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        addTree(rel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        docs.add(rel);
      }
    }
  };

  addIfExists("AGENTS.md");
  addIfExists(".github/copilot-instructions.md");
  for (const scoped of [
    "src/agent/AGENTS.md",
    "src/trading/AGENTS.md",
    "src/db/AGENTS.md",
    ".github/workflows/AGENTS.md",
  ]) {
    addIfExists(scoped);
  }
  addIfExists("README.md");
  addIfExists("DESIGN.md");
  addTree(".github/agents");
  addTree(".github/skills");
  addTree(".github/workflows");
  addTree("docs");
  addTree("specs");

  return [...docs].sort((a, b) => a.localeCompare(b, "en"));
}

/** Strip fenced code blocks so sample snippets don't register as links. */
function stripCodeFences(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
}

/** GitHub-style heading slugs for a Markdown document. */
function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  const withoutFences = stripCodeFences(markdown);
  for (const line of withoutFences.split(/\r?\n/)) {
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (!match) continue;
    const base = slugify(match[2]);
    if (!base) continue;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

function slugify(headingText: string): string {
  return headingText
    .trim()
    .replace(/`/g, "")
    .replace(/[*_~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

interface LinkRef {
  target: string;
  anchor: string | null;
  line: number;
}

function extractLinks(markdown: string): LinkRef[] {
  const refs: LinkRef[] = [];
  const scannable = stripCodeFences(markdown);
  const lines = scannable.split(/\r?\n/);
  const linkRe = /\]\(([^)]+)\)/g;
  lines.forEach((line, index) => {
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(line)) !== null) {
      const raw = match[1].trim().split(/\s+/)[0];
      if (
        !raw ||
        raw.startsWith("http://") ||
        raw.startsWith("https://") ||
        raw.startsWith("mailto:")
      ) {
        continue;
      }
      const hashIndex = raw.indexOf("#");
      const target = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
      const anchor = hashIndex === -1 ? null : raw.slice(hashIndex + 1);
      refs.push({ target, anchor, line: index + 1 });
    }
  });
  return refs;
}

interface Problem {
  doc: string;
  line: number;
  message: string;
}

function main(): void {
  const problems: Problem[] = [];
  const slugCache = new Map<string, Set<string>>();

  const slugsFor = (absPath: string): Set<string> => {
    let cached = slugCache.get(absPath);
    if (!cached) {
      cached = headingSlugs(fs.readFileSync(absPath, "utf8"));
      slugCache.set(absPath, cached);
    }
    return cached;
  };

  for (const doc of discoverDocs()) {
    const absDoc = path.join(REPO_ROOT, doc);
    const markdown = fs.readFileSync(absDoc, "utf8");
    const dir = path.dirname(absDoc);

    for (const ref of extractLinks(markdown)) {
      // Bare in-document anchor: `#section`.
      if (ref.target === "" && ref.anchor !== null) {
        if (!slugsFor(absDoc).has(ref.anchor)) {
          problems.push({
            doc,
            line: ref.line,
            message: `anchor #${ref.anchor} not found in this document`,
          });
        }
        continue;
      }

      const absTarget = path.resolve(dir, ref.target);
      // Links that escape the repository root are GitHub web-relative
      // conventions (e.g. `../../issues`), not local file references.
      const relFromRoot = path.relative(REPO_ROOT, absTarget);
      if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
        continue;
      }
      if (!fs.existsSync(absTarget)) {
        problems.push({
          doc,
          line: ref.line,
          message: `missing file reference: ${ref.target}`,
        });
        continue;
      }

      if (ref.anchor && absTarget.endsWith(".md")) {
        if (!slugsFor(absTarget).has(ref.anchor)) {
          problems.push({
            doc,
            line: ref.line,
            message: `anchor #${ref.anchor} not found in ${ref.target}`,
          });
        }
      }
    }
  }

  if (problems.length > 0) {
    process.stderr.write("✗ Broken local Markdown references:\n");
    for (const problem of problems) {
      process.stderr.write(
        `  ${problem.doc}:${problem.line} — ${problem.message}\n`,
      );
    }
    process.stderr.write(`  Fix: ${REMEDIATION}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `✓ Local Markdown references valid across ${discoverDocs().length} documentation surfaces\n`,
  );
}

main();
