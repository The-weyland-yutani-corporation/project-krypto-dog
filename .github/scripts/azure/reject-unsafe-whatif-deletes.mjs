#!/usr/bin/env node
// Strict, fail-closed guard against unsafe `az deployment group what-if`
// results. Rejects the deployment (nonzero exit) if the what-if JSON
// contains, for PostgreSQL, Key Vault, evidence storage, or a resource
// lock protecting any of those:
//   - a top-level `changeType` of Delete, Unsupported, or Ignore (any of
//     these can destroy or silently bypass review of a protected
//     resource -- see "Change types" in
//     https://learn.microsoft.com/azure/azure-resource-manager/templates/deploy-what-if,
//     and the "Unsupported"/"Ignore" values in the WhatIfChangeType SDK
//     enum), or
//   - a top-level `changeType` of Modify that touches a security- or
//     data-boundary-relevant property path (PostgreSQL version/network
//     mode/private DNS/delegated subnet; Key Vault RBAC/public
//     access/purge protection/soft delete; Storage shared-key
//     access/blob public access/public network access/network ACLs/
//     encryption; a lock's level) -- inspected recursively through the
//     `delta`/`children` property-change tree (WhatIfPropertyChange
//     schema: path, propertyChangeType, children), not just at the top
//     level, since Azure often reports a nested object as a single
//     "Modify" node whose actual leaf-level differences only appear in
//     `children`.
//
// Reads `az deployment group what-if --result-format FullResourcePayloads
// --no-pretty-print -o json` output from a file (never invents or
// re-derives that JSON itself, and never shells out to `az` on its own --
// the caller is responsible for producing the what-if JSON with its own
// literal, code-controlled `az` invocation). No `eval`, no dynamic
// command construction.
//
// Usage:
//   node reject-unsafe-whatif-deletes.mjs --file <what-if.json>
//
// Scans every change (not just the first) so the operator sees every
// unsafe change in one run, then exits 1 if any were found, printing each
// resourceId/path that triggered the block. Exits 0 only when the
// what-if JSON parses and contains zero unsafe changes.

import { readFileSync } from "node:fs";

// Matches a resourceType string (as returned by resourceTypeFromId below)
// against each protected resource family. `(\/.*)?$` intentionally allows
// nested/child resource types (e.g. a Storage blob container or
// immutability policy) to inherit the top-level-changeType protections
// (Delete/Unsupported/Ignore) of their parent resource family, even
// though the Modify property-path allowlists below only apply to the
// base resource type itself (see SENSITIVE_PROPERTY_PATHS).
const PROTECTED_TYPE_PATTERNS = [
  { key: "postgres", pattern: /^Microsoft\.DBforPostgreSQL\/flexibleServers(\/.*)?$/i },
  { key: "keyVault", pattern: /^Microsoft\.KeyVault\/vaults(\/.*)?$/i },
  { key: "storage", pattern: /^Microsoft\.Storage\/storageAccounts(\/.*)?$/i },
  { key: "lock", pattern: /^Microsoft\.Authorization\/locks$/i },
];

// Security/data-boundary property paths that must never silently change
// via a Modify what-if result, keyed by the *exact* base resource type
// (never a nested/child type -- those don't have these top-level
// `properties.*` fields). Paths are dot-separated and match the `path`
// field Azure's what-if API reports for each WhatIfPropertyChange node
// (see infra/modules/{postgresql,key-vault,storage}.bicep for the exact
// property names these mirror).
const SENSITIVE_PROPERTY_PATHS = {
  postgres: [
    "properties.version",
    "properties.network.publicNetworkAccess",
    "properties.network.privateDnsZoneArmResourceId",
    "properties.network.delegatedSubnetResourceId",
  ],
  keyVault: [
    "properties.enableRbacAuthorization",
    "properties.publicNetworkAccess",
    "properties.enablePurgeProtection",
    "properties.enableSoftDelete",
  ],
  storage: [
    "properties.allowSharedKeyAccess",
    "properties.allowBlobPublicAccess",
    "properties.publicNetworkAccess",
    "properties.networkAcls",
    "properties.encryption",
  ],
  lock: ["properties.level"],
};

// Top-level `changeType` values that are unsafe for a protected resource
// regardless of any property-level detail: Delete destroys the resource;
// Unsupported means Azure could not determine the effect of the change
// (fail closed rather than assume safety); Ignore means the resource
// exists but is being skipped from evaluation entirely (see "What-if
// limits" in the Microsoft Learn article above -- reaching a nested
// template expansion limit silently sets remaining resources to Ignore,
// which must never be treated as "no risk").
const UNSAFE_CHANGE_TYPES = new Set(["Delete", "Unsupported", "Ignore"]);

function fail(message) {
  process.stderr.write(`reject-unsafe-whatif-deletes: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${key} requires a value`);
    }
    args[name] = value;
    i += 1;
  }
  return args;
}

// Extracts the ARM resource type from a resourceId, correctly handling
// *extension* resources (locks, role assignments, etc.), which ARM gives
// a second, independent "/providers/<extensionProvider>/<extensionType>/
// <name>" segment appended after the owner resource's own id -- e.g. a
// lock on a Key Vault has an id shaped like:
//   .../providers/Microsoft.KeyVault/vaults/kv-x/providers/Microsoft.Authorization/locks/deleteLock
// A naive "find the first /providers/" extraction (the previous
// implementation) mis-parses this as "Microsoft.KeyVault/vaults/
// providers/locks", which never matches the `Microsoft.Authorization/
// locks` protected pattern -- silently defeating lock protection for
// every lock in this repo, since every one of infra/modules/
// {postgresql,key-vault,storage}.bicep's `deleteLock` resources is
// nested this way. Using the *last* "/providers/" occurrence instead
// correctly isolates the extension resource's own type, and leaves
// ordinary natively-nested resources (which only ever have one
// "/providers/", e.g. a Storage blob container) unaffected.
function resourceTypeFromId(resourceId) {
  const lower = resourceId.toLowerCase();
  const marker = "/providers/";
  let lastIndex = -1;
  let searchFrom = 0;
  for (;;) {
    const idx = lower.indexOf(marker, searchFrom);
    if (idx === -1) break;
    lastIndex = idx;
    searchFrom = idx + marker.length;
  }
  if (lastIndex === -1) return resourceId;
  const afterProviders = resourceId.slice(lastIndex + marker.length);
  const segments = afterProviders.split("/").filter(Boolean);
  if (segments.length < 2) return afterProviders;
  // segments: [provider, type, name, subtype, subname, ...]
  const typeSegments = [segments[0], segments[1]];
  for (let i = 3; i < segments.length; i += 2) {
    typeSegments.push(segments[i]);
  }
  return typeSegments.join("/");
}

function protectedFamilyForType(resourceType) {
  for (const { key, pattern } of PROTECTED_TYPE_PATTERNS) {
    if (pattern.test(resourceType)) return key;
  }
  return null;
}

// Recursively walks a WhatIfPropertyChange tree (the `delta` array at the
// top of a change, and each node's `children` array below that),
// reporting every leaf/subtree whose `path` touches one of
// `sensitivePaths`. A node "directly" matches if its own path equals or
// is nested under a sensitive path; it "ancestor" matches if a sensitive
// path is nested under it (e.g. the node is `properties.network` and the
// sensitive path is `properties.network.publicNetworkAccess`) -- in that
// case we recurse into children for a precise match, but fail closed on
// the whole subtree if Azure reported no children to inspect (a
// wholesale object replace with no leaf-level detail).
function walkPropertyChanges(nodes, sensitivePaths, onUnsafe) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    const path = typeof node?.path === "string" ? node.path : "";
    const changeType = node?.propertyChangeType;
    const children = Array.isArray(node?.children) ? node.children : [];

    // NoEffect means the property will not actually be set/updated --
    // never a real change, so never a real risk. Skip it (and its
    // children, which are moot if the field itself won't change).
    if (changeType === "NoEffect") continue;

    if (!path) {
      onUnsafe(`<property change with no 'path', propertyChangeType=${String(changeType)}>`);
      continue;
    }

    let directHit = false;
    let ancestorHit = false;
    for (const sensitivePath of sensitivePaths) {
      if (path === sensitivePath || path.startsWith(`${sensitivePath}.`)) {
        directHit = true;
      } else if (sensitivePath.startsWith(`${path}.`)) {
        ancestorHit = true;
      }
    }

    if (directHit) {
      onUnsafe(path);
      continue;
    }
    if (ancestorHit) {
      if (children.length > 0) {
        walkPropertyChanges(children, sensitivePaths, onUnsafe);
      } else {
        onUnsafe(`${path} (wholesale replace with no property-level detail)`);
      }
      continue;
    }
    // Neither directHit nor ancestorHit at this node: since every
    // descendant path is this node's path extended further, no
    // descendant can match a sensitive path either (a sensitive path
    // that were nested under a descendant would already have made this
    // node an ancestorHit). Nothing further to inspect down this branch.
  }
}

const args = parseArgs(process.argv.slice(2));
const filePath = args["file"];
if (!filePath) fail("--file is required.");

let raw;
try {
  raw = readFileSync(filePath, "utf8");
} catch (error) {
  fail(`Unable to read what-if file '${filePath}': ${error.message}`);
}

let whatIf;
try {
  whatIf = JSON.parse(raw);
} catch (error) {
  fail(`What-if file '${filePath}' is not valid JSON: ${error.message}`);
}

const changes = Array.isArray(whatIf?.changes) ? whatIf.changes : null;
if (changes === null) {
  fail(
    "What-if JSON did not contain a 'changes' array -- refusing to treat an unparseable what-if result as safe.",
  );
}

let unsafeCount = 0;
function reportUnsafe(resourceId, resourceType, detail) {
  unsafeCount += 1;
  process.stderr.write(
    `reject-unsafe-whatif-deletes: UNSAFE change on protected resource type '${resourceType}': ${resourceId}${
      detail ? ` (${detail})` : ""
    }\n`,
  );
}

for (const change of changes) {
  const changeType = typeof change?.changeType === "string" ? change.changeType : "";
  const resourceId = typeof change?.resourceId === "string" ? change.resourceId : "";

  if (!changeType) {
    fail("What-if reported a change with no 'changeType' -- refusing to treat this as safe.");
  }
  if (!resourceId) {
    fail(`What-if reported a '${changeType}' change with no resourceId -- refusing to treat this as safe.`);
  }

  const resourceType = resourceTypeFromId(resourceId);
  const family = protectedFamilyForType(resourceType);
  if (!family) continue;

  if (UNSAFE_CHANGE_TYPES.has(changeType)) {
    reportUnsafe(resourceId, resourceType, `changeType=${changeType}`);
    continue;
  }

  if (changeType === "Modify") {
    const sensitivePaths = SENSITIVE_PROPERTY_PATHS[family] ?? [];
    if (sensitivePaths.length === 0) continue;
    const delta = Array.isArray(change?.delta) ? change.delta : [];
    walkPropertyChanges(delta, sensitivePaths, (detail) => {
      reportUnsafe(resourceId, resourceType, `Modify touches ${detail}`);
    });
  }
}

if (unsafeCount > 0) {
  fail(
    `${unsafeCount} unsafe change(s) found against PostgreSQL, Key Vault, evidence storage, or a resource lock. Refusing to proceed.`,
  );
}

process.stdout.write(
  `reject-unsafe-whatif-deletes: no unsafe changes found among ${changes.length} change(s).\n`,
);
