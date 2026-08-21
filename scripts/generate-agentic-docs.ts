/**
 * Generate the marked workflow-inventory section in
 * `docs/agentic-workflows-map.md` from GH-AW source frontmatter.
 *
 * The section between the generated markers is fully machine-owned: primary
 * triggers, imported role agents, safe outputs, and AI-credit caps for every
 * source workflow. Hand-authored rationale (lifecycle, safety model, typical
 * paths, mermaid flow) lives outside the markers and is never touched.
 *
 * Usage:
 *   tsx scripts/generate-agentic-docs.ts          # rewrite the section in place
 *   tsx scripts/generate-agentic-docs.ts --check  # fail if the section is stale
 */
import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  buildWorkflowInventory,
  type WorkflowInventory,
} from "./agentic/frontmatter";

const DOC_PATH = path.join(REPO_ROOT, "docs", "agentic-workflows-map.md");
const DOC_REL = path.relative(REPO_ROOT, DOC_PATH);
const START_MARKER = "<!-- generated:workflow-inventory:start -->";
const END_MARKER = "<!-- generated:workflow-inventory:end -->";
const REMEDIATION = "npm run agentic:docs";

function escapeCell(value: string): string {
  return value.replace(/[\\|]/g, "\\$&");
}

function importsCell(inv: WorkflowInventory): string {
  return inv.imports.map((entry) => `\`${entry}\``).join(", ");
}

function triggersCell(inv: WorkflowInventory): string {
  return inv.triggers.length > 0
    ? inv.triggers.map((token) => escapeCell(token)).join("; ")
    : "—";
}

function safeOutputsCell(inv: WorkflowInventory): string {
  return inv.safeOutputs.length > 0
    ? inv.safeOutputs.map((kind) => `\`${kind}\``).join(", ")
    : "—";
}

function capsCell(inv: WorkflowInventory): string {
  const perRun = inv.creditCaps.perRun ?? "—";
  const perDay = inv.creditCaps.perDay ?? "—";
  return `${perRun} / ${perDay}`;
}

/** Render the generated section body (between, not including, the markers). */
export function renderInventorySection(
  inventory: WorkflowInventory[] = buildWorkflowInventory(),
): string {
  const lines: string[] = [];
  lines.push(
    "_Generated from `.github/workflows/*.md` frontmatter by " +
      "`scripts/generate-agentic-docs.ts`. Do not edit by hand; run " +
      `\`${REMEDIATION}\` after changing a workflow source._`,
  );
  lines.push("");
  lines.push(
    "| Workflow | Import | Primary triggers | Safe outputs | AI credits (run / day) |",
  );
  lines.push("|---|---|---|---|---|");
  for (const inv of inventory) {
    lines.push(
      `| \`${inv.id}\` | ${importsCell(inv)} | ${triggersCell(inv)} | ` +
        `${safeOutputsCell(inv)} | ${capsCell(inv)} |`,
    );
  }
  return lines.join("\n");
}

/** Replace the marked section within the document text; returns the new text. */
export function applyInventorySection(document: string): string {
  const startIndex = document.indexOf(START_MARKER);
  const endIndex = document.indexOf(END_MARKER);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(
      `${DOC_REL}: missing generated markers ` +
        `\`${START_MARKER}\` / \`${END_MARKER}\`. Restore them, then run \`${REMEDIATION}\`.`,
    );
  }
  if (endIndex < startIndex) {
    throw new Error(
      `${DOC_REL}: generated end marker precedes start marker. Fix the markers, then run \`${REMEDIATION}\`.`,
    );
  }
  const before = document.slice(0, startIndex + START_MARKER.length);
  const after = document.slice(endIndex);
  const body = renderInventorySection();
  return `${before}\n\n${body}\n\n${after}`;
}

function main(): void {
  const check = process.argv.includes("--check");
  const current = fs.readFileSync(DOC_PATH, "utf8");
  const updated = applyInventorySection(current);

  if (updated === current) {
    if (!check) {
      process.stdout.write(`${DOC_REL}: workflow inventory already current\n`);
    }
    return;
  }

  if (check) {
    process.stderr.write(
      `✗ ${DOC_REL}: generated workflow inventory is stale.\n` +
        `  Owning file: ${DOC_REL}\n` +
        `  Fix: run \`${REMEDIATION}\` and commit the result.\n`,
    );
    process.exit(1);
  }

  fs.writeFileSync(DOC_PATH, updated);
  process.stdout.write(`${DOC_REL}: workflow inventory regenerated\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  /generate-agentic-docs(\.ts|\.js)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main();
}
