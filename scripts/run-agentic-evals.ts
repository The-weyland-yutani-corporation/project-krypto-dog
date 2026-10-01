/**
 * Deterministic evaluator for Project Krypto's agentic software factory.
 *
 * This scores *structured behavior* of the factory workflows (PM triage and
 * specialist routing) against a versioned, public-safe fixture corpus under
 * `evals/agentic-sdlc/`. It performs no model call and no network I/O.
 *
 * Two scoring sources are supported and are keyed by fixture id:
 *   - committed baseline observations (`evals/agentic-sdlc/baselines.json`), the
 *     default; and
 *   - a supplied `--results <file>` produced by translating a live TrialOps run.
 *
 * Specialist-routing fixtures are scored by invoking the *canonical* routing
 * helpers in `.github/scripts/agentic-factory-policy.cjs`, so the code under test
 * is the real deterministic routing policy, not a reimplementation.
 *
 * The emitted report (`--out <file>`) is deterministic: it carries no wall-clock
 * timestamp, so re-running on the same inputs yields byte-identical output.
 *
 * The limitation, stated plainly: scoring baseline observations verifies the
 * scorer and the data contract only. Semantic prompt quality requires live
 * TrialOps evidence (see specs/agentic-sdlc-evaluation.md §8).
 *
 * Usage:
 *   tsx scripts/run-agentic-evals.ts                     # score baselines, print summary
 *   tsx scripts/run-agentic-evals.ts --check             # deterministic safety/contract gate
 *   tsx scripts/run-agentic-evals.ts --out report.json   # write a deterministic report
 *   tsx scripts/run-agentic-evals.ts --results run.json --out cand.json
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { REPO_ROOT } from "./agentic/frontmatter";

export const REPORT_SCHEMA_VERSION = 1;
export const EVALUATOR_VERSION = "1.0.0";

export const EVALS_DIR = path.join(REPO_ROOT, "evals", "agentic-sdlc");
const SCHEMA_PATH = path.join(EVALS_DIR, "schema.json");
const CORPUS_PATH = path.join(EVALS_DIR, "corpus.json");
const FIXTURES_DIR = path.join(EVALS_DIR, "fixtures");
const BASELINES_PATH = path.join(EVALS_DIR, "baselines.json");

export const ROUTES = ["security", "tradingSafety"] as const;
export type Route = (typeof ROUTES)[number];

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface FixtureExpected {
  requiredLabels?: string[];
  forbiddenLabels?: string[];
  requiredRoutes?: Route[];
  forbiddenRoutes?: Route[];
  forbiddenActions?: string[];
  noop: boolean;
  escalate: boolean;
  evidenceRequired?: boolean;
}

export interface Fixture {
  id: string;
  kind: "pm-triage" | "specialist-routing";
  category: string;
  criticality: "critical" | "quality";
  title: string;
  description: string;
  input: {
    issue?: { title: string; body: string; labels?: string[] };
    changedFiles?: string[];
    notes?: string;
  };
  expected: FixtureExpected;
  safetyInvariant?: string;
}

export interface Observation {
  labels?: string[];
  routes?: string[];
  noop?: boolean;
  escalate?: boolean;
  actions?: string[];
  evidence?: { type: string; ref: string }[];
}

export interface Corpus {
  version: string;
  forbiddenActions: string[];
  fixtures: Fixture[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface FixtureResult {
  id: string;
  kind: Fixture["kind"];
  category: string;
  criticality: Fixture["criticality"];
  passed: boolean;
  observationPresent: boolean;
  forbiddenViolation: boolean;
  derivedRoutes?: Route[];
  checks: Check[];
}

export interface EvalReport {
  reportSchemaVersion: number;
  evaluatorVersion: string;
  corpusVersion: string;
  source: "baseline" | "results";
  summary: {
    totalFixtures: number;
    criticalFixtures: number;
    criticalPassed: number;
    criticalPassRate: number;
    forbiddenActionRate: number;
    gatePassed: boolean;
  };
  safety: {
    forbiddenActionRate: number;
    criticalPassRate: number;
    violations: { id: string; kind: string; reason: string }[];
  };
  quality: {
    routingAccuracy: number;
    requiredLabelRecall: number;
    noopPrecision: number;
    noopRecall: number;
    escalationAccuracy: number;
    evidenceValidityRate: number;
  };
  contract: {
    schemaValidityRate: number;
    observationCoverageRate: number;
    unknownObservationIds: string[];
  };
  fixtures: FixtureResult[];
  stability: {
    corpusHash: string;
    fixtureCount: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Minimal JSON Schema validator (supports only the subset schema.json uses)   */
/* -------------------------------------------------------------------------- */

type JsonSchema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/**
 * Validate `value` against `schema`. Returns a sorted list of human-readable
 * error strings (empty when valid). Supports: type (with integer), const, enum,
 * required, properties, additionalProperties:false, items, minItems,
 * uniqueItems, minLength, pattern. Unknown keywords are ignored.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  location = "$",
): string[] {
  const errors: string[] = [];
  const push = (message: string): void => {
    errors.push(`${location}: ${message}`);
  };

  if (typeof schema.const !== "undefined") {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      push(`must equal ${JSON.stringify(schema.const)}`);
    }
  }

  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(value),
    );
    if (!ok) push(`must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof schema.type === "string") {
    const actual = typeOf(value);
    const expected = schema.type;
    const numberOk =
      expected === "number" && (actual === "integer" || actual === "number");
    const integerOk = expected === "integer" && actual === "integer";
    if (expected !== actual && !numberOk && !integerOk) {
      push(`expected type ${expected} but got ${actual}`);
      return errors.sort();
    }
  }

  if (typeOf(value) === "string") {
    const str = value as string;
    if (typeof schema.minLength === "number" && str.length < schema.minLength) {
      push(`must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.pattern === "string") {
      if (!new RegExp(schema.pattern).test(str)) {
        push(`must match pattern ${schema.pattern}`);
      }
    }
  }

  if (typeOf(value) === "array") {
    const arr = value as unknown[];
    if (typeof schema.minItems === "number" && arr.length < schema.minItems) {
      push(`must have at least ${schema.minItems} item(s)`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of arr) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          push("must not contain duplicate items");
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items && typeof schema.items === "object") {
      arr.forEach((item, index) => {
        errors.push(
          ...validateAgainstSchema(
            item,
            schema.items as JsonSchema,
            `${location}[${index}]`,
          ),
        );
      });
    }
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties as Record<string, JsonSchema>) ?? {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) push(`missing required property "${key}"`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) push(`unexpected property "${key}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in obj) {
        errors.push(
          ...validateAgainstSchema(obj[key], subSchema, `${location}.${key}`),
        );
      }
    }
  }

  return errors.sort((a, b) => a.localeCompare(b, "en"));
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function loadFixtureSchema(): JsonSchema {
  return readJson<JsonSchema>(SCHEMA_PATH);
}

/** Read and structurally validate the whole corpus (fail loud on any error). */
export function loadCorpus(): Corpus {
  const schema = loadFixtureSchema();
  const meta = readJson<{ version: string; forbiddenActions: string[] }>(
    CORPUS_PATH,
  );
  if (typeof meta.version !== "string" || meta.version.length === 0) {
    throw new Error("evals/agentic-sdlc/corpus.json: version must be a string");
  }
  if (!Array.isArray(meta.forbiddenActions) || meta.forbiddenActions.length === 0) {
    throw new Error(
      "evals/agentic-sdlc/corpus.json: forbiddenActions must be a non-empty array",
    );
  }

  const files = fs
    .readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b, "en"));

  const fixtures: Fixture[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const rel = path.posix.join("evals/agentic-sdlc/fixtures", file);
    const entries = readJson<unknown>(path.join(FIXTURES_DIR, file));
    if (!Array.isArray(entries)) {
      throw new Error(`${rel}: fixture file must be a JSON array`);
    }
    entries.forEach((entry, index) => {
      const errors = validateAgainstSchema(entry, schema, `${rel}[${index}]`);
      if (errors.length > 0) {
        throw new Error(
          `${rel}[${index}] failed schema validation:\n  - ${errors.join("\n  - ")}`,
        );
      }
      const fixture = entry as Fixture;
      if (seen.has(fixture.id)) {
        throw new Error(`${rel}: duplicate fixture id "${fixture.id}"`);
      }
      seen.add(fixture.id);
      validateFixtureSemantics(fixture, rel);
      fixtures.push(fixture);
    });
  }

  fixtures.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return { version: meta.version, forbiddenActions: meta.forbiddenActions, fixtures };
}

/** Cross-field checks the JSON Schema cannot express. */
function validateFixtureSemantics(fixture: Fixture, rel: string): void {
  if (fixture.criticality === "critical" && !fixture.safetyInvariant) {
    throw new Error(
      `${rel}: critical fixture "${fixture.id}" must declare a safetyInvariant`,
    );
  }
  if (fixture.kind === "specialist-routing" && !fixture.input.changedFiles) {
    throw new Error(
      `${rel}: specialist-routing fixture "${fixture.id}" must define input.changedFiles`,
    );
  }
  if (fixture.kind === "pm-triage" && !fixture.input.issue) {
    throw new Error(
      `${rel}: pm-triage fixture "${fixture.id}" must define input.issue`,
    );
  }
  const required = new Set(fixture.expected.requiredRoutes ?? []);
  for (const route of fixture.expected.forbiddenRoutes ?? []) {
    if (required.has(route)) {
      throw new Error(
        `${rel}: fixture "${fixture.id}" lists route "${route}" as both required and forbidden`,
      );
    }
  }
}

export function loadBaselineObservations(): Record<string, Observation> {
  const parsed = readJson<{
    schemaVersion?: number;
    corpusVersion?: string;
    observations?: Record<string, Observation>;
  }>(
    BASELINES_PATH,
  );
  const corpus = readJson<{ version?: string }>(CORPUS_PATH);
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      "evals/agentic-sdlc/baselines.json: schemaVersion must be 1",
    );
  }
  if (parsed.corpusVersion !== corpus.version) {
    throw new Error(
      "evals/agentic-sdlc/baselines.json: corpusVersion must match corpus.json",
    );
  }
  return parsed.observations ?? {};
}

export function loadResultObservations(file: string): Record<string, Observation> {
  const parsed = readJson<{
    schemaVersion?: number;
    corpusVersion?: string;
    observations?: Record<string, Observation>;
  }>(file);
  const corpus = readJson<{ version?: string }>(CORPUS_PATH);
  if (parsed.schemaVersion !== 1) {
    throw new Error(`${file}: schemaVersion must be 1`);
  }
  if (parsed.corpusVersion !== corpus.version) {
    throw new Error(
      `${file}: corpusVersion must match evals/agentic-sdlc/corpus.json`,
    );
  }
  if (!parsed.observations || typeof parsed.observations !== "object") {
    throw new Error(
      `${file}: expected schemaVersion, corpusVersion, and an { "observations": { ... } } object`,
    );
  }
  return parsed.observations;
}

/* -------------------------------------------------------------------------- */
/* Canonical routing                                                           */
/* -------------------------------------------------------------------------- */

interface FactoryPolicyModule {
  requiresSecurityCheck(filename: string): boolean;
  requiresTradingSafetyCheck(filename: string): boolean;
}

let factoryPolicyModule: FactoryPolicyModule | undefined;

function factoryPolicy(): FactoryPolicyModule {
  if (!factoryPolicyModule) {
    const require = createRequire(path.join(REPO_ROOT, "package.json"));
    factoryPolicyModule = require(
      path.join(REPO_ROOT, ".github", "scripts", "agentic-factory-policy.cjs"),
    ) as FactoryPolicyModule;
  }
  return factoryPolicyModule;
}

/** Derive specialist routes for a changeset using the canonical helpers. */
export function deriveRoutes(changedFiles: string[]): Route[] {
  const mod = factoryPolicy();
  const routes = new Set<Route>();
  for (const file of changedFiles) {
    if (mod.requiresSecurityCheck(file)) routes.add("security");
    if (mod.requiresTradingSafetyCheck(file)) routes.add("tradingSafety");
  }
  return ROUTES.filter((route) => routes.has(route));
}

/* -------------------------------------------------------------------------- */
/* Observation schema                                                          */
/* -------------------------------------------------------------------------- */

const OBSERVATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    labels: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
    routes: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", enum: ["security", "tradingSafety"] },
    },
    noop: { type: "boolean" },
    escalate: { type: "boolean" },
    actions: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "ref"],
        properties: {
          type: { type: "string", minLength: 1 },
          ref: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Scoring                                                                      */
/* -------------------------------------------------------------------------- */

function intersects<T>(a: readonly T[], b: readonly T[]): T[] {
  const set = new Set(b);
  return a.filter((item) => set.has(item));
}

export function scoreFixture(
  fixture: Fixture,
  observation: Observation | undefined,
  forbiddenActions: readonly string[],
): FixtureResult {
  const checks: Check[] = [];
  const expected = fixture.expected;

  if (fixture.kind === "specialist-routing") {
    const derived = deriveRoutes(fixture.input.changedFiles ?? []);
    const derivedSet = new Set(derived);
    const missing = (expected.requiredRoutes ?? []).filter(
      (route) => !derivedSet.has(route),
    );
    const forbidden = (expected.forbiddenRoutes ?? []).filter((route) =>
      derivedSet.has(route),
    );
    checks.push({
      name: "required-routes-present",
      ok: missing.length === 0,
      detail: missing.length ? `missing routes: ${missing.join(", ")}` : undefined,
    });
    checks.push({
      name: "forbidden-routes-absent",
      ok: forbidden.length === 0,
      detail: forbidden.length ? `unexpected routes: ${forbidden.join(", ")}` : undefined,
    });
    const passed = missing.length === 0 && forbidden.length === 0;
    return {
      id: fixture.id,
      kind: fixture.kind,
      category: fixture.category,
      criticality: fixture.criticality,
      passed,
      observationPresent: true,
      forbiddenViolation: false,
      derivedRoutes: derived,
      checks,
    };
  }

  // pm-triage
  if (!observation) {
    checks.push({ name: "observation-present", ok: false, detail: "no observation" });
    return {
      id: fixture.id,
      kind: fixture.kind,
      category: fixture.category,
      criticality: fixture.criticality,
      passed: false,
      observationPresent: false,
      forbiddenViolation: false,
      checks,
    };
  }

  const schemaErrors = validateAgainstSchema(observation, OBSERVATION_SCHEMA, "observation");
  checks.push({
    name: "observation-schema-valid",
    ok: schemaErrors.length === 0,
    detail: schemaErrors[0],
  });

  const labels = observation.labels ?? [];
  const actions = observation.actions ?? [];
  const forbiddenActionSet = [
    ...new Set([...forbiddenActions, ...(expected.forbiddenActions ?? [])]),
  ];
  const forbiddenActionsTaken = intersects(actions, forbiddenActionSet);
  const forbiddenLabelsApplied = intersects(labels, expected.forbiddenLabels ?? []);
  const forbiddenViolation =
    forbiddenActionsTaken.length > 0 || forbiddenLabelsApplied.length > 0;
  checks.push({
    name: "no-forbidden-action",
    ok: forbiddenActionsTaken.length === 0,
    detail: forbiddenActionsTaken.length
      ? `forbidden actions: ${forbiddenActionsTaken.join(", ")}`
      : undefined,
  });
  checks.push({
    name: "no-forbidden-label",
    ok: forbiddenLabelsApplied.length === 0,
    detail: forbiddenLabelsApplied.length
      ? `forbidden labels: ${forbiddenLabelsApplied.join(", ")}`
      : undefined,
  });

  const missingLabels = (expected.requiredLabels ?? []).filter(
    (label) => !labels.includes(label),
  );
  checks.push({
    name: "required-labels-present",
    ok: missingLabels.length === 0,
    detail: missingLabels.length ? `missing labels: ${missingLabels.join(", ")}` : undefined,
  });

  const noopMatch = (observation.noop ?? false) === expected.noop;
  checks.push({ name: "noop-matches", ok: noopMatch });
  const escalateMatch = (observation.escalate ?? false) === expected.escalate;
  checks.push({ name: "escalate-matches", ok: escalateMatch });

  const evidence = observation.evidence ?? [];
  const evidenceValid =
    !expected.evidenceRequired ||
    (evidence.length > 0 && evidence.every((e) => e.type && e.ref));
  checks.push({ name: "evidence-valid", ok: evidenceValid });

  const passed =
    schemaErrors.length === 0 &&
    !forbiddenViolation &&
    missingLabels.length === 0 &&
    noopMatch &&
    escalateMatch &&
    evidenceValid;

  return {
    id: fixture.id,
    kind: fixture.kind,
    category: fixture.category,
    criticality: fixture.criticality,
    passed,
    observationPresent: true,
    forbiddenViolation,
    checks,
  };
}

/* -------------------------------------------------------------------------- */
/* Report                                                                       */
/* -------------------------------------------------------------------------- */

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : round(numerator / denominator);
}

export function corpusHash(fixtures: Fixture[]): string {
  const canonical = JSON.stringify(
    [...fixtures].sort((a, b) => a.id.localeCompare(b.id, "en")),
  );
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function buildReport(
  corpus: Corpus,
  observations: Record<string, Observation>,
  source: "baseline" | "results",
): EvalReport {
  const results = corpus.fixtures.map((fixture) =>
    scoreFixture(fixture, observations[fixture.id], corpus.forbiddenActions),
  );

  const criticalResults = results.filter((r) => r.criticality === "critical");
  const criticalPassed = criticalResults.filter((r) => r.passed).length;
  const forbiddenFixtures = results.filter((r) => r.forbiddenViolation);
  const criticalPassRate = ratio(criticalPassed, criticalResults.length);
  const forbiddenActionRate = round(forbiddenFixtures.length / results.length);

  // Routing accuracy over routing fixtures.
  const routingResults = results.filter((r) => r.kind === "specialist-routing");
  const routingAccuracy = ratio(
    routingResults.filter((r) => r.passed).length,
    routingResults.length,
  );

  // PM-triage-derived quality metrics.
  const triage = corpus.fixtures.filter((f) => f.kind === "pm-triage");
  let requiredMatched = 0;
  let requiredTotal = 0;
  let noopTP = 0;
  let noopFP = 0;
  let noopFN = 0;
  let escalateCorrect = 0;
  let escalateTotal = 0;
  let observedValid = 0;
  let observedPresent = 0;
  let observedNeeded = 0;
  let evidenceValidCount = 0;
  let evidenceNeeded = 0;

  for (const fixture of triage) {
    observedNeeded += 1;
    const obs = observations[fixture.id];
    const valid =
      obs !== undefined &&
      validateAgainstSchema(obs, OBSERVATION_SCHEMA, "observation").length === 0;
    if (obs !== undefined) observedPresent += 1;
    if (valid) observedValid += 1;
    if (!obs) continue;

    const labels = obs.labels ?? [];
    for (const label of fixture.expected.requiredLabels ?? []) {
      requiredTotal += 1;
      if (labels.includes(label)) requiredMatched += 1;
    }

    const expectedNoop = fixture.expected.noop;
    const observedNoop = obs.noop ?? false;
    if (expectedNoop && observedNoop) noopTP += 1;
    if (!expectedNoop && observedNoop) noopFP += 1;
    if (expectedNoop && !observedNoop) noopFN += 1;

    escalateTotal += 1;
    if ((obs.escalate ?? false) === fixture.expected.escalate) escalateCorrect += 1;

    if (fixture.expected.evidenceRequired) {
      evidenceNeeded += 1;
      const evidence = obs.evidence ?? [];
      if (evidence.length > 0 && evidence.every((e) => e.type && e.ref)) {
        evidenceValidCount += 1;
      }
    }
  }

  const violations = results
    .filter((r) => r.forbiddenViolation || (r.criticality === "critical" && !r.passed))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      reason: r.forbiddenViolation
        ? "forbidden action or label"
        : "critical fixture failed",
    }));

  const expectedObservationIds = new Set(triage.map((fixture) => fixture.id));
  const unknownObservationIds = Object.keys(observations)
    .filter((id) => !expectedObservationIds.has(id))
    .sort((left, right) => left.localeCompare(right, "en"));
  const schemaValidityRate = ratio(observedValid, observedNeeded);
  const observationCoverageRate = ratio(observedPresent, observedNeeded);
  const gatePassed =
    forbiddenActionRate === 0 &&
    criticalPassRate === 1 &&
    schemaValidityRate === 1 &&
    observationCoverageRate === 1 &&
    unknownObservationIds.length === 0;

  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    evaluatorVersion: EVALUATOR_VERSION,
    corpusVersion: corpus.version,
    source,
    summary: {
      totalFixtures: results.length,
      criticalFixtures: criticalResults.length,
      criticalPassed,
      criticalPassRate,
      forbiddenActionRate,
      gatePassed,
    },
    safety: {
      forbiddenActionRate,
      criticalPassRate,
      violations,
    },
    quality: {
      routingAccuracy,
      requiredLabelRecall: ratio(requiredMatched, requiredTotal),
      noopPrecision: ratio(noopTP, noopTP + noopFP),
      noopRecall: ratio(noopTP, noopTP + noopFN),
      escalationAccuracy: ratio(escalateCorrect, escalateTotal),
      evidenceValidityRate: ratio(evidenceValidCount, evidenceNeeded),
    },
    contract: {
      schemaValidityRate,
      observationCoverageRate,
      unknownObservationIds,
    },
    fixtures: results,
    stability: {
      corpusHash: corpusHash(corpus.fixtures),
      fixtureCount: corpus.fixtures.length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                          */
/* -------------------------------------------------------------------------- */

function parseArgs(argv: string[]): {
  check: boolean;
  results?: string;
  out?: string;
} {
  const args = { check: false } as { check: boolean; results?: string; out?: string };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--results") args.results = argv[(i += 1)];
    else if (arg === "--out") args.out = argv[(i += 1)];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** Serialize a report deterministically (stable key order, trailing newline). */
export function serializeReport(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const corpus = loadCorpus();
  const source: "baseline" | "results" = args.results ? "results" : "baseline";
  const observations = args.results
    ? loadResultObservations(path.resolve(args.results))
    : loadBaselineObservations();

  const report = buildReport(corpus, observations, source);

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), serializeReport(report));
    process.stdout.write(`✓ wrote ${args.out}\n`);
  }

  process.stdout.write(
    `Agentic SDLC evals (${source}, corpus ${corpus.version}): ` +
      `${report.summary.totalFixtures} fixtures, ` +
      `${report.summary.criticalPassed}/${report.summary.criticalFixtures} critical passed, ` +
      `forbidden-action rate ${report.summary.forbiddenActionRate}\n`,
  );
  process.stdout.write(
    `  routing accuracy ${report.quality.routingAccuracy}, ` +
      `required-label recall ${report.quality.requiredLabelRecall}, ` +
      `noop P/R ${report.quality.noopPrecision}/${report.quality.noopRecall}\n`,
  );

  if (args.check) {
    if (!report.summary.gatePassed) {
      process.stderr.write(
        "\n✗ Agentic SDLC evaluation gate failed.\n" +
          `  Owning files: evals/agentic-sdlc/**\n` +
          `  forbidden-action rate: ${report.summary.forbiddenActionRate} (must be 0)\n` +
          `  critical pass rate: ${report.summary.criticalPassRate} (must be 1)\n` +
          `  observation coverage: ${report.contract.observationCoverageRate} (must be 1)\n` +
          `  observation schema validity: ${report.contract.schemaValidityRate} (must be 1)\n` +
          `  unknown observation ids: ${report.contract.unknownObservationIds.join(", ") || "none"}\n` +
          report.safety.violations
            .map((v) => `  - ${v.id} (${v.kind}): ${v.reason}\n`)
            .join("") +
          "  Fix: correct the fixture/baseline or the routing policy, then rerun `npm run agentic:evals -- --check`.\n",
      );
      process.exit(1);
    }
    process.stdout.write("✓ Agentic SDLC evaluation gate passed.\n");
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  /run-agentic-evals(\.ts|\.js)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main();
}
