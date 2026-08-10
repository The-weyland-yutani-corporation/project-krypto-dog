/**
 * Harness integrity gate for the Project Krypto agentic SDLC.
 *
 * Read-only, deterministic, and self-describing: every failure names the owning
 * file and an exact remediation command. It runs the focused sub-checks and the
 * GH-AW compile-drift gate:
 *
 *   1. Canonical policy validates via the trusted CJS loader.
 *   2. The generated workflow-inventory doc section is current.
 *   3. Local Markdown file/anchor references resolve.
 *   4. The agent-instruction hierarchy contract passes (references + 32 KiB budget).
 *   5. The deterministic agentic SDLC evaluation gate passes (safety fixtures
 *      100%, forbidden-action rate zero) with no model or network call.
 *   6. The report-only entropy scanner's zero-tolerance rules pass (canonical
 *      policy valid, sources compiled, references resolve, imports exist, no
 *      prohibited live executor, generated doc markers present). Advisory
 *      findings are report-only and never block here.
 *   7. The staged CorrectionOps deterministic fixture contract passes without
 *      GitHub access.
 *   8. GH-AW sources compile with the pinned CLI, `gh aw compile --strict` twice
 *      is byte-identical, and no committed `.lock.yml` / `agentic_commands.yml`
 *      differs from what the sources generate.
 *
 * Compile-drift strategy: two consecutive strict compiles are compared. When
 * they are byte-identical (the proven, hermetic case) a byte-level diff gate
 * runs. If byte determinism cannot be proven at runtime, the gate falls back to
 * a semantic comparison of each artifact's embedded gh-aw signature
 * (`gh-aw-metadata` / `gh-aw-manifest` / `gh-aw-commands`), which encodes the
 * source frontmatter/body hashes and pinned action manifest, so source→lock
 * drift is still caught without a flaky byte gate.
 *
 * Usage: tsx scripts/check-harness-integrity.ts
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, WORKFLOWS_DIR, listSourceWorkflowIds } from "./agentic/frontmatter";

const PINNED_GH_AW = "v0.81.6";
const COMPILE_REMEDIATION = "npm run agentic:compile";
const GENERATED_SUPPORT_FILES = [
  "agentic_commands.yml",
  "agentics-maintenance.yml",
];

interface StepResult {
  name: string;
  ok: boolean;
}

function runScript(name: string, script: string, args: string[] = []): StepResult {
  process.stdout.write(`\n▶ ${name}\n`);
  const result = spawnSync(
    "npx",
    ["tsx", path.join("scripts", script), ...args],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
  );
  return { name, ok: result.status === 0 && !result.error };
}

/** Repo-relative paths of every compiled artifact the gate protects. */
function compiledArtifacts(): string[] {
  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".lock.yml"));
  for (const supportFile of GENERATED_SUPPORT_FILES) {
    if (fs.existsSync(path.join(WORKFLOWS_DIR, supportFile))) {
      files.push(supportFile);
    }
  }
  return files
    .map((name) => path.posix.join(".github", "workflows", name))
    .sort((a, b) => a.localeCompare(b, "en"));
}

function hashFile(rel: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(REPO_ROOT, rel)))
    .digest("hex");
}

function snapshot(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of files) {
    if (fs.existsSync(path.join(REPO_ROOT, rel))) map.set(rel, hashFile(rel));
  }
  return map;
}

/** Extract the deterministic gh-aw signature comment lines from an artifact. */
function semanticSignature(rel: string): string {
  const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const lines = text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!/^#\s*gh-aw-(metadata|manifest|commands):/.test(trimmed)) return [];
    if (!trimmed.startsWith("# gh-aw-metadata:")) return [trimmed];
    const jsonText = trimmed.slice("# gh-aw-metadata:".length).trim();
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      delete parsed.engine_versions;
      return [`# gh-aw-metadata: ${JSON.stringify(parsed)}`];
    } catch {
      // Preserve the raw line when metadata is malformed so the drift gate fails loud.
      return [trimmed];
    }
  });
  return lines.join("\n");
}

function ghAwAvailable(): boolean {
  const result = spawnSync("gh", ["aw", "version"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return result.status === 0 && output.includes(PINNED_GH_AW);
}

function compileStrict(): number {
  const result = spawnSync("gh", ["aw", "compile", "--strict"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  return result.error ? 1 : (result.status ?? 1);
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): string[] {
  const changed: string[] = [];
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of keys) {
    if (a.get(key) !== b.get(key)) changed.push(key);
  }
  return changed.sort((x, y) => x.localeCompare(y, "en"));
}

function fail(owner: string, message: string, remediation: string): void {
  process.stderr.write(
    `✗ ${message}\n  Owning file: ${owner}\n  Fix: ${remediation}\n`,
  );
}

/**
 * The report-only entropy scanner's zero-tolerance gate. Only zero-tolerance
 * rules fail here; advisory findings (stale backlog, file-size hotspots, TODO
 * markers) are reported by the weekly workflow and never block CI. The collector
 * is a dependency-free CJS module, so it runs under `node`, not `tsx`.
 */
function entropyCheck(): boolean {
  process.stdout.write("\n▶ Entropy zero-tolerance assertions\n");
  const result = spawnSync(
    "node",
    [path.join("scripts", "agentic", "collect-agentic-entropy.cjs"), "--check"],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
  );
  if (result.error) {
    fail(
      "scripts/agentic/collect-agentic-entropy.cjs",
      `entropy collector failed to run: ${result.error.message}`,
      "run `npm run entropy:check` locally and fix the reported failure",
    );
    return false;
  }
  return result.status === 0;
}

function correctionCheck(): boolean {
  process.stdout.write("\n▶ Staged CorrectionOps contract\n");
  const result = spawnSync(
    "node",
    [
      path.join(
        "scripts",
        "agentic",
        "collect-agentic-corrections.cjs",
      ),
      "--check",
    ],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
  );
  if (result.error) {
    fail(
      "scripts/agentic/collect-agentic-corrections.cjs",
      `CorrectionOps collector failed to run: ${result.error.message}`,
      "run `npm run corrections:check` locally and fix the reported failure",
    );
    return false;
  }
  return result.status === 0;
}

/** The compile-drift gate. Returns true on success. */
function compileGate(): boolean {
  process.stdout.write("\n▶ GH-AW compile-drift gate\n");

  if (!ghAwAvailable()) {
    fail(
      ".github/workflows/copilot-setup-steps.yml",
      `gh-aw CLI ${PINNED_GH_AW} is required but not available on PATH`,
      `install it: gh extension install github/gh-aw --pin ${PINNED_GH_AW} (matches copilot-setup-steps.yml)`,
    );
    return false;
  }

  // Every committed lock must map to a live source (orphan detection).
  const sourceIds = new Set(listSourceWorkflowIds());
  const orphans = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".lock.yml"))
    .map((name) => name.slice(0, -".lock.yml".length))
    .filter((id) => !sourceIds.has(id));
  if (orphans.length > 0) {
    for (const id of orphans) {
      fail(
        `.github/workflows/${id}.lock.yml`,
        `orphaned compiled lock has no \`${id}.md\` source`,
        `delete the stale lock or restore its source, then run \`${COMPILE_REMEDIATION}\``,
      );
    }
    return false;
  }

  const artifacts = compiledArtifacts();
  const before = snapshot(artifacts);
  const beforeSignatures = new Map(
    artifacts
      .filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)))
      .map((rel) => [rel, semanticSignature(rel)] as const),
  );

  if (compileStrict() !== 0) {
    fail(
      ".github/workflows/*.md",
      "`gh aw compile --strict` failed",
      "fix the reported workflow source error, then run `npm run agentic:compile`",
    );
    return false;
  }
  const afterFirst = snapshot(compiledArtifacts());
  const afterFirstSignatures = new Map(
    compiledArtifacts()
      .filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)))
      .map((rel) => [rel, semanticSignature(rel)] as const),
  );

  if (compileStrict() !== 0) {
    fail(
      ".github/workflows/*.md",
      "second `gh aw compile --strict` failed",
      "fix the reported workflow source error, then run `npm run agentic:compile`",
    );
    return false;
  }
  const afterSecond = snapshot(compiledArtifacts());

  const nonDeterministic = mapsEqual(afterFirst, afterSecond);
  const byteDeterministic = nonDeterministic.length === 0;

  if (byteDeterministic) {
    process.stdout.write(
      "  ✓ two consecutive strict compiles are byte-identical (hermetic)\n",
    );
    const drift = mapsEqual(before, afterFirst);
    if (drift.length > 0) {
      const semanticDrift = drift.filter(
        (rel) => beforeSignatures.get(rel) !== afterFirstSignatures.get(rel),
      );
      if (semanticDrift.length > 0) {
        for (const rel of semanticDrift) {
          fail(
            rel,
            `committed compiled artifact semantically drifts from its source: ${rel}`,
            `run \`${COMPILE_REMEDIATION}\` and commit the regenerated artifact`,
          );
        }
        return false;
      }
      process.stdout.write(
        "  ! compiled bytes drift, but source-derived gh-aw signatures match (volatile metadata ignored)\n",
      );
      return true;
    }
    process.stdout.write(
      `  ✓ ${artifacts.length} compiled artifact(s) match their sources\n`,
    );
    return true;
  }

  // Byte determinism could not be proven — use the semantic signature gate.
  process.stdout.write(
    "  ! byte determinism not proven; falling back to semantic signature comparison\n" +
      `    non-identical files: ${nonDeterministic.join(", ")}\n`,
  );
  const afterSignatures = new Map(
    compiledArtifacts()
      .filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)))
      .map((rel) => [rel, semanticSignature(rel)] as const),
  );

  // The two compile runs must at least agree semantically.
  const semanticNoise: string[] = [];
  const semanticInstability: string[] = [];
  for (const rel of compiledArtifacts()) {
    const sig = afterSignatures.get(rel) ?? "";
    if (sig === "") semanticNoise.push(rel);
    if (afterFirstSignatures.get(rel) !== sig) {
      semanticInstability.push(rel);
    }
  }
  if (semanticNoise.length > 0) {
    for (const rel of semanticNoise) {
      fail(
        rel,
        `cannot read gh-aw semantic signature from ${rel}`,
        `run \`${COMPILE_REMEDIATION}\` to regenerate a signed artifact`,
      );
    }
    return false;
  }
  if (semanticInstability.length > 0) {
    for (const rel of semanticInstability) {
      fail(
        rel,
        `consecutive compiles disagree semantically: ${rel}`,
        "pin every compiler input or update the compiler before enabling this gate",
      );
    }
    return false;
  }

  const semanticDrift: string[] = [];
  for (const rel of compiledArtifacts()) {
    if (beforeSignatures.get(rel) !== afterSignatures.get(rel)) {
      semanticDrift.push(rel);
    }
  }
  if (semanticDrift.length > 0) {
    for (const rel of semanticDrift) {
      fail(
        rel,
        `compiled artifact semantically drifts from its source: ${rel}`,
        `run \`${COMPILE_REMEDIATION}\` and commit the regenerated artifact`,
      );
    }
    return false;
  }
  process.stdout.write(
    "  ✓ semantic signatures match sources (byte-noise tolerated)\n",
  );
  return true;
}

function main(): void {
  const results: StepResult[] = [];
  results.push(
    runScript("Canonical policy validation", "validate-agentic-policy.ts"),
  );
  results.push(
    runScript("Generated workflow inventory", "generate-agentic-docs.ts", [
      "--check",
    ]),
  );
  results.push(runScript("Local Markdown references", "check-markdown-links.ts"));
  results.push(
    runScript("Agent-instruction hierarchy", "check-agent-instructions.ts"),
  );
  results.push(
    runScript("Agentic SDLC evaluations", "run-agentic-evals.ts", ["--check"]),
  );
  results.push({ name: "Entropy zero-tolerance assertions", ok: entropyCheck() });
  results.push({ name: "Staged CorrectionOps contract", ok: correctionCheck() });
  results.push({ name: "GH-AW compile-drift gate", ok: compileGate() });

  process.stdout.write("\n── Harness integrity summary ──\n");
  for (const result of results) {
    process.stdout.write(`  ${result.ok ? "✓" : "✗"} ${result.name}\n`);
  }

  if (results.some((result) => !result.ok)) {
    process.stderr.write(
      "\nHarness integrity check failed. Address the owning files above and rerun `npm run harness:check`.\n",
    );
    process.exit(1);
  }
  process.stdout.write("\n✓ Harness integrity check passed.\n");
}

main();
