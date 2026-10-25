"use strict";

const { inflateRawSync } = require("node:zlib");

// Read one explicitly named, bounded file without extracting archive paths.
function readSingleFileArchive(data, name, maxSize = 65536) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ||
      !Number.isSafeInteger(maxSize) || maxSize < 1 || maxSize > 524288) {
    throw new Error("Invalid receipt archive constraints.");
  }
  const zip = Buffer.from(data);
  if (zip.length < 22 || zip.length > 262144) throw new Error("Invalid receipt archive size.");
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > zip.length ||
      end + 22 + zip.readUInt16LE(end + 20) !== zip.length ||
      zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0 ||
      zip.readUInt16LE(end + 8) !== 1 || zip.readUInt16LE(end + 10) !== 1) {
    throw new Error("Receipt archive must contain exactly one entry.");
  }
  const directorySize = zip.readUInt32LE(end + 12);
  const directory = zip.readUInt32LE(end + 16);
  if (directory + directorySize !== end || directory + 46 > end ||
      zip.readUInt32LE(directory) !== 0x02014b50) throw new Error("Invalid receipt directory.");
  const flags = zip.readUInt16LE(directory + 8);
  const method = zip.readUInt16LE(directory + 10);
  const compressedSize = zip.readUInt32LE(directory + 20);
  const size = zip.readUInt32LE(directory + 24);
  const nameLength = zip.readUInt16LE(directory + 28);
  const extraLength = zip.readUInt16LE(directory + 30);
  const commentLength = zip.readUInt16LE(directory + 32);
  const local = zip.readUInt32LE(directory + 42);
  if ((flags & ~0x0808) !== 0 || ![0, 8].includes(method) || size > maxSize ||
      directory + 46 + nameLength + extraLength + commentLength !== end ||
      zip.subarray(directory + 46, directory + 46 + nameLength).toString("utf8") !== name ||
      local + 30 > directory || zip.readUInt32LE(local) !== 0x04034b50) {
    throw new Error("Unsupported receipt archive entry.");
  }
  const localNameLength = zip.readUInt16LE(local + 26);
  const start = local + 30 + localNameLength + zip.readUInt16LE(local + 28);
  if (start + compressedSize > directory ||
      zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method ||
      zip.subarray(local + 30, local + 30 + localNameLength).toString("utf8") !== name) {
    throw new Error("Invalid receipt payload.");
  }
  const compressed = zip.subarray(start, start + compressedSize);
  const content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maxSize });
  if (content.length !== size) throw new Error("Receipt length mismatch.");
  return content.toString("utf8");
}

function readReceiptArchive(data) {
  return JSON.parse(readSingleFileArchive(data, "receipt.json"));
}

async function loadRunArchive({ github, owner, repo, run, name }) {
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner, repo, run_id: run.id, per_page: 100,
  });
  const matching = artifacts.filter((artifact) =>
    artifact.name === name && !artifact.expired);
  if (matching.length !== 1) throw new Error("A unique trusted-run verdict receipt is required.");
  const download = await github.rest.actions.downloadArtifact({
    owner, repo, artifact_id: matching[0].id, archive_format: "zip",
  });
  return readReceiptArchive(download.data);
}

async function loadRunReceipt({ github, owner, repo, run, headSha }) {
  const receipt = await loadRunArchive({
    github, owner, repo, run, name: `factory-receipt-${headSha}-${run.run_attempt}`,
  });
  if (receipt.schemaVersion !== 1 || receipt.runId !== run.id ||
      receipt.runAttempt !== run.run_attempt || receipt.headSha !== headSha ||
      !Array.isArray(receipt.checks)) throw new Error("Verdict receipt does not match its trusted run.");
  return receipt;
}

module.exports = { readSingleFileArchive, readReceiptArchive, loadRunArchive, loadRunReceipt };
