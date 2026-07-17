import { z } from "zod/v4";
import {
  canonicalJson,
  canonicalSha256,
  sha256Hex,
  stablePrettyJson,
} from "./canonical";

export const EVIDENCE_DATASET_SCHEMA_VERSION = "1.0.0";
export const EVIDENCE_CANONICAL_HASH_DESCRIPTION =
  "SHA-256 of the UTF-8 bytes, with no BOM or trailing newline, of canonical JSON for schemaVersion, the semantic manifest excluding both hash fields, observations, gaps, and paperExecutions; importer materialization metadata is excluded, object keys are lexicographically sorted recursively, and array order is preserved.";
export const EVIDENCE_SOURCE_HASH_DESCRIPTION =
  "SHA-256 of the exact raw input data-file bytes supplied to the importer.";
export const EVIDENCE_MATERIALIZED_HASH_DESCRIPTION =
  "SHA-256 of the exact UTF-8 bytes emitted by serializeEvidenceDataset: recursively key-sorted, two-space-indented JSON with one trailing LF, including materialization metadata, sourceFileSha256, and canonicalContentSha256.";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must start with an alphanumeric character and contain only letters, numbers, ., _, :, or -",
  );

const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 hex digest");

export const evidenceTimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const evidenceSourceSchema = z
  .object({
    kind: z.enum([
      "exchange-api",
      "paper-ledger",
      "operator-export",
      "fixture",
      "other",
    ]),
    name: z.string().trim().min(1).max(500),
    locator: z.string().trim().min(1).max(2000).optional(),
    notes: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

export const evidenceAcquisitionWindowSchema = z
  .object({
    start: evidenceTimestampSchema,
    end: evidenceTimestampSchema,
  })
  .strict()
  .superRefine((window, ctx) => {
    if (Date.parse(window.start) >= Date.parse(window.end)) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "acquisition window end must be after start",
      });
    }
  });

export const evidenceManifestInputSchema = z
  .object({
    datasetId: identifierSchema,
    assetPair: z.literal("ETH/USDC"),
    source: evidenceSourceSchema,
    acquisitionWindow: evidenceAcquisitionWindowSchema,
    intendedRole: z.enum(["training", "validation", "holdout"]),
    expectedIntervalSeconds: z.number().int().positive(),
  })
  .strict();

export const evidenceObservationSchema = z
  .object({
    timestamp: evidenceTimestampSchema,
    priceUSD: z.number().finite().positive(),
  })
  .strict();

export const evidenceGapSchema = z
  .object({
    afterTimestamp: evidenceTimestampSchema,
    beforeTimestamp: evidenceTimestampSchema,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const externalPaperExecutionSchema = z
  .object({
    executionId: z.string().trim().min(1).max(200).optional(),
    timestamp: evidenceTimestampSchema,
    side: z.enum(["BUY", "SELL"]),
    quantityETH: z.number().finite().positive(),
    notionalUSD: z.number().finite().positive(),
    observedPriceUSD: z.number().finite().positive(),
    executionPriceUSD: z.number().finite().positive(),
    feesUSD: z.number().finite().nonnegative(),
    slippageUSD: z.number().finite().nonnegative(),
    realizedPnlUSD: z.number().finite().nullable().default(null),
    sourceReference: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

const evidenceDatasetInputObjectSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_DATASET_SCHEMA_VERSION),
    manifest: evidenceManifestInputSchema,
    observations: z.array(evidenceObservationSchema).min(2),
    gaps: z.array(evidenceGapSchema),
    paperExecutions: z.array(externalPaperExecutionSchema).default([]),
  })
  .strict();

type DatasetRelationshipInput = z.output<
  typeof evidenceDatasetInputObjectSchema
>;

function addRelationshipIssue(
  ctx: z.core.$RefinementCtx<DatasetRelationshipInput>,
  path: PropertyKey[],
  message: string,
): void {
  ctx.addIssue({ code: "custom", path, message });
}

function validateDatasetRelationships(
  dataset: DatasetRelationshipInput,
  ctx: z.core.$RefinementCtx<DatasetRelationshipInput>,
): void {
  const observationTimes = dataset.observations.map((observation) =>
    Date.parse(observation.timestamp),
  );
  for (let index = 1; index < observationTimes.length; index++) {
    if (observationTimes[index] <= observationTimes[index - 1]) {
      addRelationshipIssue(
        ctx,
        ["observations", index, "timestamp"],
        "observation timestamps must be strictly ascending without duplicates",
      );
    }
  }

  const firstTimestamp = dataset.observations[0].timestamp;
  const lastTimestamp =
    dataset.observations[dataset.observations.length - 1].timestamp;
  if (dataset.manifest.acquisitionWindow.start !== firstTimestamp) {
    addRelationshipIssue(
      ctx,
      ["manifest", "acquisitionWindow", "start"],
      "acquisition window start must equal the first observation timestamp",
    );
  }
  if (dataset.manifest.acquisitionWindow.end !== lastTimestamp) {
    addRelationshipIssue(
      ctx,
      ["manifest", "acquisitionWindow", "end"],
      "acquisition window end must equal the last observation timestamp",
    );
  }

  const gapKeys = new Set<string>();
  let previousGapEnd = -Infinity;
  for (let index = 0; index < dataset.gaps.length; index++) {
    const gap = dataset.gaps[index];
    const after = Date.parse(gap.afterTimestamp);
    const before = Date.parse(gap.beforeTimestamp);
    if (after >= before) {
      addRelationshipIssue(
        ctx,
        ["gaps", index, "beforeTimestamp"],
        "gap beforeTimestamp must be after afterTimestamp",
      );
    }
    if (after < previousGapEnd) {
      addRelationshipIssue(
        ctx,
        ["gaps", index, "afterTimestamp"],
        "gaps must be ordered and non-overlapping",
      );
    }
    previousGapEnd = before;
    const key = `${gap.afterTimestamp}|${gap.beforeTimestamp}`;
    if (gapKeys.has(key)) {
      addRelationshipIssue(
        ctx,
        ["gaps", index],
        "duplicate gap declaration",
      );
    }
    gapKeys.add(key);
  }

  const expectedIntervalMs =
    dataset.manifest.expectedIntervalSeconds * 1000;
  const matchedGapKeys = new Set<string>();
  for (let index = 1; index < dataset.observations.length; index++) {
    const previous = dataset.observations[index - 1];
    const current = dataset.observations[index];
    const deltaMs =
      Date.parse(current.timestamp) - Date.parse(previous.timestamp);
    const gapKey = `${previous.timestamp}|${current.timestamp}`;
    const hasDeclaredGap = gapKeys.has(gapKey);
    if (deltaMs < expectedIntervalMs) {
      addRelationshipIssue(
        ctx,
        ["observations", index, "timestamp"],
        "observation interval is shorter than expectedIntervalSeconds",
      );
      continue;
    }
    if (deltaMs % expectedIntervalMs !== 0) {
      addRelationshipIssue(
        ctx,
        ["observations", index, "timestamp"],
        "observation interval must be an exact multiple of expectedIntervalSeconds",
      );
      continue;
    }
    if (deltaMs === expectedIntervalMs && hasDeclaredGap) {
      addRelationshipIssue(
        ctx,
        ["gaps"],
        `gap ${gapKey} declares no missing expected observation`,
      );
    } else if (deltaMs > expectedIntervalMs && !hasDeclaredGap) {
      addRelationshipIssue(
        ctx,
        ["observations", index, "timestamp"],
        `missing observations between ${previous.timestamp} and ${current.timestamp} require an explicit gap declaration`,
      );
    } else if (deltaMs > expectedIntervalMs) {
      matchedGapKeys.add(gapKey);
    }
  }
  for (let index = 0; index < dataset.gaps.length; index++) {
    const gap = dataset.gaps[index];
    const key = `${gap.afterTimestamp}|${gap.beforeTimestamp}`;
    if (!matchedGapKeys.has(key)) {
      addRelationshipIssue(
        ctx,
        ["gaps", index],
        "gap must exactly connect two adjacent observations separated by one or more missing expected intervals",
      );
    }
  }

  const firstTime = observationTimes[0];
  const lastTime = observationTimes[observationTimes.length - 1];
  let previousExecutionTime = -Infinity;
  for (
    let index = 0;
    index < dataset.paperExecutions.length;
    index++
  ) {
    const executionTime = Date.parse(
      dataset.paperExecutions[index].timestamp,
    );
    if (executionTime <= previousExecutionTime) {
      addRelationshipIssue(
        ctx,
        ["paperExecutions", index, "timestamp"],
        "paper execution timestamps must be strictly ascending without duplicates",
      );
    }
    if (executionTime < firstTime || executionTime > lastTime) {
      addRelationshipIssue(
        ctx,
        ["paperExecutions", index, "timestamp"],
        "paper execution timestamp must be within the acquisition and observation bounds",
      );
    }
    previousExecutionTime = executionTime;
  }
}

export const evidenceDatasetInputSchema =
  evidenceDatasetInputObjectSchema.superRefine(
    validateDatasetRelationships,
  );

export type EvidenceManifestInput = z.output<
  typeof evidenceManifestInputSchema
>;
export type EvidenceObservation = z.output<
  typeof evidenceObservationSchema
>;
export type EvidenceGap = z.output<typeof evidenceGapSchema>;
export type ExternalPaperExecution = z.output<
  typeof externalPaperExecutionSchema
>;
export type EvidenceDatasetInput = z.output<
  typeof evidenceDatasetInputSchema
>;

export const evidenceManifestSchema = evidenceManifestInputSchema.extend({
  sourceFileSha256: sha256Schema,
  canonicalContentSha256: sha256Schema,
});

export const evidenceMaterializationSchema = z
  .object({
    sourceFormat: z.enum(["json", "csv"]),
  })
  .strict();

const evidenceDatasetObjectSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_DATASET_SCHEMA_VERSION),
    materialization: evidenceMaterializationSchema,
    manifest: evidenceManifestSchema,
    observations: z.array(evidenceObservationSchema).min(2),
    gaps: z.array(evidenceGapSchema),
    paperExecutions: z.array(externalPaperExecutionSchema),
  })
  .strict();

function canonicalDatasetContent(
  dataset: EvidenceDatasetInput,
): EvidenceDatasetInput {
  return {
    schemaVersion: dataset.schemaVersion,
    manifest: dataset.manifest,
    observations: dataset.observations,
    gaps: dataset.gaps,
    paperExecutions: dataset.paperExecutions,
  };
}

export const evidenceDatasetSchema =
  evidenceDatasetObjectSchema.superRefine((dataset, ctx) => {
    const relationshipDataset: EvidenceDatasetInput = {
      schemaVersion: dataset.schemaVersion,
      manifest: {
        datasetId: dataset.manifest.datasetId,
        assetPair: dataset.manifest.assetPair,
        source: dataset.manifest.source,
        acquisitionWindow: dataset.manifest.acquisitionWindow,
        intendedRole: dataset.manifest.intendedRole,
        expectedIntervalSeconds:
          dataset.manifest.expectedIntervalSeconds,
      },
      observations: dataset.observations,
      gaps: dataset.gaps,
      paperExecutions: dataset.paperExecutions,
    };
    validateDatasetRelationships(relationshipDataset, ctx);
    const expectedHash = canonicalSha256(
      canonicalDatasetContent(relationshipDataset),
    );
    if (
      dataset.manifest.canonicalContentSha256 !== expectedHash
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["manifest", "canonicalContentSha256"],
        message: `canonical content hash mismatch; expected ${expectedHash}`,
      });
    }
  });

export type EvidenceDataset = z.output<typeof evidenceDatasetSchema>;

export const evidenceCsvDescriptorSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_DATASET_SCHEMA_VERSION),
    manifest: evidenceManifestInputSchema,
    gaps: z.array(evidenceGapSchema),
    paperExecutions: z.array(externalPaperExecutionSchema).default([]),
  })
  .strict();

export type EvidenceCsvDescriptor = z.output<
  typeof evidenceCsvDescriptorSchema
>;

function sourceBytes(source: string | Uint8Array): Uint8Array {
  return typeof source === "string"
    ? Buffer.from(source, "utf8")
    : source;
}

function decodeUtf8(source: string | Uint8Array): string {
  if (typeof source === "string") return source;
  return new TextDecoder("utf-8", { fatal: true }).decode(source);
}

function materializeEvidenceDataset(
  input: unknown,
  rawSource: string | Uint8Array,
  sourceFormat: "json" | "csv",
): EvidenceDataset {
  const parsed = evidenceDatasetInputSchema.parse(input);
  const canonicalContentSha256 = canonicalSha256(
    canonicalDatasetContent(parsed),
  );
  return evidenceDatasetSchema.parse({
    ...parsed,
    materialization: { sourceFormat },
    manifest: {
      ...parsed.manifest,
      sourceFileSha256: sha256Hex(sourceBytes(rawSource)),
      canonicalContentSha256,
    },
  });
}

export function importEvidenceJson(
  source: string | Uint8Array,
): EvidenceDataset {
  const text = decodeUtf8(source);
  return materializeEvidenceDataset(JSON.parse(text), source, "json");
}

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let closedQuote = false;

  const finishField = (): void => {
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRow = (): void => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote) {
      if (character === ",") {
        finishField();
      } else if (character === "\n") {
        finishRow();
      } else if (character === "\r") {
        if (source[index + 1] === "\n") index++;
        finishRow();
      } else {
        throw new Error(
          `CSV contains unexpected character after a closing quote at byte ${index}`,
        );
      }
      continue;
    }
    if (character === '"') {
      if (field.length > 0) {
        throw new Error(
          `CSV quote must begin at the start of a field at byte ${index}`,
        );
      }
      inQuotes = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRow();
    } else if (character === "\r") {
      if (source[index + 1] === "\n") index++;
      finishRow();
    } else {
      field += character;
    }
  }
  if (inQuotes) {
    throw new Error("CSV contains an unterminated quoted field");
  }
  if (closedQuote || field.length > 0 || row.length > 0) {
    finishRow();
  }
  return rows;
}

function csvObservations(source: string): EvidenceObservation[] {
  const rows = parseCsvRows(source);
  if (rows.length === 0) {
    throw new Error("CSV input must contain a header and observations");
  }
  if (rows[0][0]?.charCodeAt(0) === 0xfeff) {
    rows[0][0] = rows[0][0].slice(1);
  }
  if (
    rows[0].length !== 2 ||
    rows[0][0] !== "timestamp" ||
    rows[0][1] !== "priceUSD"
  ) {
    throw new Error(
      "CSV header must be exactly timestamp,priceUSD",
    );
  }
  return rows.slice(1).map((columns, index) => {
    const line = index + 2;
    if (columns.length !== 2) {
      throw new Error(`CSV line ${line} must contain exactly two fields`);
    }
    const [timestamp, priceText] = columns;
    if (timestamp.length === 0 || priceText.length === 0) {
      throw new Error(`CSV line ${line} contains an empty field`);
    }
    if (priceText.trim() !== priceText) {
      throw new Error(
        `CSV line ${line} priceUSD must not contain surrounding whitespace`,
      );
    }
    const priceUSD = Number(priceText);
    if (!Number.isFinite(priceUSD)) {
      throw new Error(`CSV line ${line} priceUSD must be finite`);
    }
    return { timestamp, priceUSD };
  });
}

export function importEvidenceCsv(
  source: string | Uint8Array,
  descriptor: unknown,
): EvidenceDataset {
  const parsedDescriptor =
    evidenceCsvDescriptorSchema.parse(descriptor);
  const input: EvidenceDatasetInput = {
    schemaVersion: parsedDescriptor.schemaVersion,
    manifest: parsedDescriptor.manifest,
    observations: csvObservations(decodeUtf8(source)),
    gaps: parsedDescriptor.gaps,
    paperExecutions: parsedDescriptor.paperExecutions,
  };
  return materializeEvidenceDataset(input, source, "csv");
}

export function parseEvidenceDataset(value: unknown): EvidenceDataset {
  return evidenceDatasetSchema.parse(value);
}

export function loadEvidenceDataset(source: string): EvidenceDataset {
  return parseEvidenceDataset(JSON.parse(source));
}

export function serializeEvidenceDataset(
  dataset: EvidenceDataset,
): string {
  return stablePrettyJson(parseEvidenceDataset(dataset));
}

export function evidenceDatasetMaterializedSha256(
  dataset: EvidenceDataset,
): string {
  return sha256Hex(
    Buffer.from(serializeEvidenceDataset(dataset), "utf8"),
  );
}

export function evidenceDatasetCanonicalJson(
  dataset: EvidenceDataset,
): string {
  const parsed = parseEvidenceDataset(dataset);
  return canonicalJson(
    canonicalDatasetContent({
      schemaVersion: parsed.schemaVersion,
      manifest: {
        datasetId: parsed.manifest.datasetId,
        assetPair: parsed.manifest.assetPair,
        source: parsed.manifest.source,
        acquisitionWindow: parsed.manifest.acquisitionWindow,
        intendedRole: parsed.manifest.intendedRole,
        expectedIntervalSeconds:
          parsed.manifest.expectedIntervalSeconds,
      },
      observations: parsed.observations,
      gaps: parsed.gaps,
      paperExecutions: parsed.paperExecutions,
    }),
  );
}
