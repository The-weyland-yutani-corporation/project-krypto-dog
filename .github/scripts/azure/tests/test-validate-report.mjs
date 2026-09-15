#!/usr/bin/env node
// Executable, dependency-free regression test harness for
// validate-report.mjs, focused on the "Fix 6" security-review
// requirement: a promotion rollout's imageDigest must be confirmed equal
// to the validated target-smoke report's digest before any rollout, and
// a release-SHA mismatch, a not-passed report, a non-'disabled'
// rolloutMode, or a binding/top-level digest disagreement must all fail
// closed.
//
// Spawns the real validate-report.mjs as a subprocess against fixture
// report.json files under tests/fixtures/reports/ and asserts the exit
// code (0 = accept, 1 = reject) matches expectation -- never re-implements
// or mocks the validator's logic.
//
// Usage: node test-validate-report.mjs

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "..", "validate-report.mjs");
const fixturesDir = path.join(__dirname, "fixtures", "reports");

const RELEASE_SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RELEASE_SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_1 =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_2 =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";

let passCount = 0;
let failCount = 0;

function run(fixtureName, args, expectAccept, description) {
  const reportPath = path.join(fixturesDir, fixtureName);
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--report", reportPath, ...args],
    { encoding: "utf8" },
  );
  const accepted = result.status === 0;
  const ok = accepted === expectAccept;
  const label = expectAccept ? "ACCEPT" : "REJECT";
  if (ok) {
    passCount += 1;
    console.log(`PASS  ${description}  [expect ${label}, got exit=${result.status}]`);
  } else {
    failCount += 1;
    console.log(`FAIL  ${description}  [expect ${label}, got exit=${result.status}]`);
    console.log(`      stdout: ${result.stdout.trim()}`);
    console.log(`      stderr: ${result.stderr.trim()}`);
  }
}

// --- Baseline: a fully consistent, passed target-smoke report is accepted. ---
run(
  "target-smoke-pass.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  true,
  "consistent passed target-smoke report (releaseSha + imageDigest match)",
);

// --- Fix 6 core case: rollout imageDigest input must equal the report's digest. ---
run(
  "target-smoke-pass.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_2],
  false,
  "rollout image_digest input does NOT match report's top-level imageDigest -- must reject",
);

run(
  "target-smoke-digest-mismatch.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report's own top-level imageDigest differs from the expected digest -- must reject",
);

run(
  "target-smoke-binding-digest-mismatch.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report.binding.imageDigest disagrees with report.imageDigest -- must reject (binding checked independently)",
);

// --- Release SHA binding must also match exactly. ---
run(
  "target-smoke-sha-mismatch.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report's releaseSha does not match the expected release_sha input -- must reject",
);

run(
  "target-smoke-sha-mismatch.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_B, "--image-digest", DIGEST_1],
  true,
  "report's releaseSha DOES match when the expected SHA is the fixture's own SHA (sanity check)",
);

// --- Only a `passed: true` report may be used for promotion. ---
run(
  "target-smoke-not-passed.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report has passed=false -- must reject even with matching sha/digest",
);

// --- rolloutMode must be 'disabled' (a target-smoke run is never itself a live rollout). ---
run(
  "target-smoke-not-disabled.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A, "--image-digest", DIGEST_1],
  false,
  "report has rolloutMode != 'disabled' -- must reject",
);

// --- A bound report cannot omit its expected digest, even when it passed. ---
run(
  "target-smoke-pass.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A],
  false,
  "a passed target-smoke still requires an independently expected image digest",
);

run(
  "target-smoke-not-passed.json",
  ["--operation", "target-smoke", "--release-sha", RELEASE_SHA_A],
  false,
  "omitting --image-digest does not bypass the passed=true requirement",
);

console.log(`\n${passCount + failCount} assertions run, ${passCount} passed, ${failCount} failed.`);
process.exit(failCount === 0 ? 0 : 1);
