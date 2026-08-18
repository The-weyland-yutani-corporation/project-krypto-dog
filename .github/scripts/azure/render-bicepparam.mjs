#!/usr/bin/env node
// Renders a deploy-ready copy of a committed, nonsecret .bicepparam file
// by replacing literal `REPLACE_WITH_...` placeholder tokens with values
// resolved earlier in the same workflow run (environment.bicep outputs,
// resolved image digests, the release commit SHA, etc.).
//
// This exists because `az deployment group create`/`what-if` only accept
// a single `--parameters <file>.bicepparam` argument -- unlike a plain
// JSON parameters file, a .bicepparam file cannot be combined with
// additional `--parameters key=value` overrides in the same command (the
// Azure CLI documents this restriction explicitly). Rather than
// hand-maintaining a second, uncommitted parameter format, this script
// starts from the exact committed file (so every already-reviewed
// nonsecret value -- job names, hostnames, tags, etc. -- is preserved
// unchanged) and only ever overwrites the specific placeholder tokens the
// caller explicitly supplies.
//
// Every substitution is a literal, non-regex substring replace
// (String.prototype.replaceAll on an exact token) -- never `eval`, never
// a template engine, never a dynamically constructed shell command. No
// secret value should ever be passed to this script: @secure() bicepparam
// parameters already resolve from environment variables via
// readEnvironmentVariable() inside the .bicepparam file itself and are
// untouched here.
//
// A second, narrower substitution mode -- `--set-string-param NAME=VALUE`
// -- exists only for the handful of already-reviewed *literal* string
// parameters that a promotion workflow must deliberately change from
// their committed, safe-by-default value (e.g. rollout.bicep's
// `rolloutMode`/`hourlyTriggerType`/`dailyTriggerType`, which are
// committed as 'disabled'/'Manual'/'Manual' and are never a
// `REPLACE_WITH_` placeholder). It replaces the *entire* single-quoted
// string literal on the one line matching `param NAME = '...'`, and nowhere
// else in the file -- never a raw substring replace, so it can never
// collide with an unrelated occurrence of the same text elsewhere in the
// template. VALUE must not itself contain a single quote (every real
// value used with this flag -- a Bicep string-enum member -- never does).
//
// Usage:
//   node render-bicepparam.mjs \
//     --template infra/params/release.dev.bicepparam \
//     --out /tmp/release.dev.resolved.bicepparam \
//     --set REPLACE_WITH_ENVIRONMENT_OUTPUT_containerAppsEnvironmentId=<value> \
//     --set REPLACE_WITH_PUSHED_WEB_DIGEST=<64-hex> \
//     --set-string-param rolloutMode=shadow \
//     [...repeat --set/--set-string-param as needed]
//
// Fails closed:
//   - any --set token that does not appear (verbatim) in the template is
//     a hard error (protects against a stale/typo'd token name silently
//     doing nothing);
//   - any --set-string-param NAME whose `param NAME = '...'` line is not
//     found exactly once in the template is a hard error;
//   - any remaining `REPLACE_WITH_` substring left in the rendered output
//     after all supplied substitutions are applied is a hard error (a
//     placeholder the caller forgot to supply is never deployed as if it
//     were a real value).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

function fail(message) {
  process.stderr.write(`render-bicepparam: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const templatePathParts = [];
  let templatePath;
  let outPath;
  const sets = [];
  const stringParamSets = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--template") {
      templatePath = argv[i + 1];
      i += 1;
    } else if (arg === "--out") {
      outPath = argv[i + 1];
      i += 1;
    } else if (arg === "--set") {
      sets.push(argv[i + 1]);
      i += 1;
    } else if (arg === "--set-string-param") {
      stringParamSets.push(argv[i + 1]);
      i += 1;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  if (!templatePath) fail("--template is required.");
  if (!outPath) fail("--out is required.");

  const substitutions = new Map();
  for (const entry of sets) {
    if (entry === undefined) fail("--set requires a value.");
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      fail(`--set value must be TOKEN=value (got: ${entry})`);
    }
    const token = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!token.startsWith("REPLACE_WITH_")) {
      fail(
        `--set token '${token}' does not start with REPLACE_WITH_ -- refusing to replace an arbitrary, non-placeholder substring.`
      );
    }
    if (value === "") {
      fail(`--set token '${token}' was given an empty value.`);
    }
    if (value.includes("REPLACE_WITH_")) {
      fail(
        `--set token '${token}' was given a value that itself contains REPLACE_WITH_ -- refusing a value that looks like an unresolved placeholder.`
      );
    }
    substitutions.set(token, value);
  }

  const stringParamSubstitutions = new Map();
  for (const entry of stringParamSets) {
    if (entry === undefined) fail("--set-string-param requires a value.");
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      fail(`--set-string-param value must be NAME=value (got: ${entry})`);
    }
    const name = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
      fail(`--set-string-param name '${name}' is not a plain Bicep identifier.`);
    }
    if (value === "") {
      fail(`--set-string-param '${name}' was given an empty value.`);
    }
    if (value.includes("'")) {
      fail(
        `--set-string-param '${name}' value must not contain a single quote (got: ${value}).`
      );
    }
    stringParamSubstitutions.set(name, value);
  }

  void templatePathParts;
  return { templatePath, outPath, substitutions, stringParamSubstitutions };
}

const { templatePath, outPath, substitutions, stringParamSubstitutions } = parseArgs(
  process.argv.slice(2)
);

let content;
try {
  content = readFileSync(templatePath, "utf8");
} catch (err) {
  fail(`Could not read --template '${templatePath}': ${err.message}`);
}

// A .bicepparam file's `using '<relative-path>'` clause is resolved
// relative to the .bicepparam file's own directory, and Bicep hard-rejects
// an absolute path there (BCP051: "Files must be referenced using
// relative paths."). Since --out is typically a scratch path (e.g. under
// /tmp) that is *not* infra/params/, the committed relative path (e.g.
// '../release.bicep') would silently resolve to the wrong location (or
// nothing at all) once copied there. Recompute the correct relative path
// from --out's directory to the real, repo-relative .bicep file the
// template's own `using` clause already names, and rewrite only that one
// line -- every other line (including all REPLACE_WITH_ substitutions
// below) is untouched by this step.
const usingLineRegex = /^using\s+'([^']+)'\s*$/m;
const usingMatches = content.match(new RegExp(usingLineRegex, "gm")) ?? [];
if (usingMatches.length === 0) {
  fail(`No 'using '<path>.bicep'' line was found verbatim in '${templatePath}'.`);
}
if (usingMatches.length > 1) {
  fail(
    `Multiple 'using '<path>.bicep'' lines were found in '${templatePath}' -- refusing an ambiguous rewrite.`
  );
}
const usingMatch = content.match(usingLineRegex);
const originalUsingPath = usingMatch[1];
const absoluteBicepPath = resolve(dirname(templatePath), originalUsingPath);
let rewrittenUsingPath = relative(dirname(outPath), absoluteBicepPath)
  .split(sep)
  .join("/");
if (!rewrittenUsingPath.startsWith(".")) {
  rewrittenUsingPath = `./${rewrittenUsingPath}`;
}
content = content.replace(usingLineRegex, `using '${rewrittenUsingPath}'`);

for (const [token, value] of substitutions) {
  if (!content.includes(token)) {
    fail(
      `Token '${token}' was not found verbatim in '${templatePath}' -- refusing to proceed with a substitution that would silently do nothing.`
    );
  }
  content = content.split(token).join(value);
}

for (const [name, value] of stringParamSubstitutions) {
  const lineRegex = new RegExp(`^(\\s*param\\s+${name}\\s*=\\s*)'[^']*'(\\s*)$`, "m");
  const matches = content.match(new RegExp(lineRegex, "gm")) ?? [];
  if (matches.length === 0) {
    fail(
      `No line matching 'param ${name} = '...'' was found verbatim in '${templatePath}'.`
    );
  }
  if (matches.length > 1) {
    fail(
      `Multiple lines matching 'param ${name} = '...'' were found in '${templatePath}' -- refusing an ambiguous replacement.`
    );
  }
  content = content.replace(lineRegex, `$1'${value}'$2`);
}

// Only the actual `param x = '...'` value lines matter for the leftover
// check -- explanatory `//` comments (e.g. "values marked
// REPLACE_WITH_ENVIRONMENT_OUTPUT_* must be copied from...") legitimately
// reference the token family without being an unresolved placeholder
// value, so they are excluded here to avoid a false-positive hard
// failure on documentation text.
const nonCommentLines = content
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
const leftoverMatch = nonCommentLines.match(/REPLACE_WITH_[A-Za-z0-9_]*/);
if (leftoverMatch) {
  fail(
    `Rendered output for '${templatePath}' still contains an unresolved placeholder '${leftoverMatch[0]}'. Every REPLACE_WITH_ token in the template must be supplied via --set.`
  );
}

writeFileSync(outPath, content, "utf8");
process.stdout.write(`Rendered '${templatePath}' -> '${outPath}'\n`);
