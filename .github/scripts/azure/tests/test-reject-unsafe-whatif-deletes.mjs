#!/usr/bin/env node
// Executable fixture test harness for reject-unsafe-whatif-deletes.mjs.
// No test framework / dependencies -- spawns the real script as a
// subprocess (never imports its internals, since the script is a
// top-level program that calls process.exit()) against each JSON fixture
// under tests/fixtures/, and asserts the expected exit code.
//
// Usage: node tests/test-reject-unsafe-whatif-deletes.mjs
// Exits 0 if every case matches expectations, 1 otherwise (printing a
// PASS/FAIL line per case plus a summary).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "reject-unsafe-whatif-deletes.mjs");
const fixturesDir = join(here, "fixtures");

// expectSafe: true  -> script must exit 0 (no unsafe changes found)
// expectSafe: false -> script must exit 1 (unsafe change correctly rejected)
const CASES = [
  { file: "safe-no-changes.json", expectSafe: true },
  { file: "safe-unrelated-delete.json", expectSafe: true },
  { file: "safe-modify-postgres-unrelated-field.json", expectSafe: true },
  { file: "safe-modify-noeffect-sensitive-path.json", expectSafe: true },
  { file: "safe-modify-tags-only.json", expectSafe: true },
  { file: "safe-ignore-unchanged-external-storage.json", expectSafe: true },

  { file: "unsafe-delete-postgres.json", expectSafe: false },
  { file: "unsafe-unsupported-keyvault.json", expectSafe: false },
  { file: "unsafe-ignore-storage.json", expectSafe: false },
  { file: "unsafe-delete-storage-blob-container.json", expectSafe: false },

  // Regression coverage for the resourceTypeFromId() "first vs last
  // /providers/" bug: locks nested under each of the three protected
  // resource families must be detected as Microsoft.Authorization/locks,
  // not mangled into an unmatched pseudo-type.
  { file: "unsafe-delete-lock-nested-under-keyvault.json", expectSafe: false },
  { file: "unsafe-delete-lock-nested-under-postgres.json", expectSafe: false },
  { file: "unsafe-delete-lock-nested-under-storage.json", expectSafe: false },
  { file: "unsafe-modify-lock-level.json", expectSafe: false },

  // Recursive Modify/delta/children property-path inspection.
  { file: "unsafe-modify-postgres-public-access-nested.json", expectSafe: false },
  { file: "unsafe-modify-keyvault-rbac-direct.json", expectSafe: false },
  { file: "unsafe-modify-storage-networkacls-wholesale.json", expectSafe: false },
  { file: "unsafe-modify-keyvault-ancestor-no-children.json", expectSafe: false },

  // Fail-closed on malformed what-if data.
  { file: "malformed-missing-resourceid.json", expectSafe: false },
];

let failures = 0;

for (const { file, expectSafe } of CASES) {
  const fixturePath = join(fixturesDir, file);
  const result = spawnSync(process.execPath, [scriptPath, "--file", fixturePath], {
    encoding: "utf8",
  });
  const exitedZero = result.status === 0;
  const ok = exitedZero === expectSafe;
  const label = expectSafe ? "expect PASS (exit 0)" : "expect BLOCK (exit 1)";
  if (ok) {
    console.log(`PASS  ${file}  [${label}, got exit=${result.status}]`);
  } else {
    failures += 1;
    console.error(`FAIL  ${file}  [${label}, got exit=${result.status}]`);
    if (result.stdout) console.error(`  stdout: ${result.stdout.trim()}`);
    if (result.stderr) console.error(`  stderr: ${result.stderr.trim()}`);
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} cases passed.`);
if (failures > 0) {
  console.error(`${failures} fixture case(s) FAILED.`);
  process.exit(1);
}
