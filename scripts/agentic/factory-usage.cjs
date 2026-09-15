"use strict";

const fs = require("node:fs");
const path = require("node:path");

function appliedOutcomes(text) {
  const counts = { succeeded: 0, failed: 0, noop: 0 };
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error(`invalid-safe-output-artifact-line-${index + 1}`);
    }
    if (item.error || ["failure", "failed", "error"].includes(item.status)) counts.failed += 1;
    else if (Number.isFinite(Date.parse(item.applied_at || item.timestamp || item.created_at || ""))) {
      if (item.type === "noop") counts.noop += 1;
      else counts.succeeded += 1;
    } else return null;
  }
  return counts;
}

function enrichUsageRows(rows, outputDir) {
  const byRun = new Map();
  function walk(directory, depth) {
    const infoPath = path.join(directory, "aw_info.json");
    const appliedPath = path.join(directory, "safe-outputs-items", "safe-output-items.jsonl");
    if (fs.existsSync(infoPath) && fs.existsSync(appliedPath)) {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      if (info.run_id) byRun.set(String(info.run_id), appliedOutcomes(fs.readFileSync(appliedPath, "utf8")));
    }
    if (depth >= 2) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(directory, entry.name), depth + 1);
    }
  }
  if (fs.existsSync(outputDir)) walk(outputDir, 0);
  return rows.map((row) => {
    const id = String(row.run_id || row.databaseId || row.id || "");
    return byRun.has(id) ? { ...row, safeOutputOutcomes: byRun.get(id) } : row;
  });
}

module.exports = { appliedOutcomes, enrichUsageRows };
