"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const SERIES = Object.freeze({
  daily: { prefix: "[factory-status] ", hash: "factory-state-hash" },
  governance: { prefix: "[factory-governance] ", hash: "factory-state-hash" },
  entropy: { prefix: "[factory-entropy] ", hash: "entropy-state-hash" },
  corrections: { prefix: "[factory-corrections] ", hash: "correction-state-hash" },
});

function marker(series) {
  if (!SERIES[series]) throw new Error("unknown-report-series");
  return `<!-- factory-report:v1 ${series} -->`;
}

function labels(issue) {
  return (issue.labels || []).map((label) => typeof label === "string" ? label : label.name);
}

function canonicalReport(issues, series) {
  const candidates = issues.filter((issue) => {
    const author = issue.user || issue.author || {};
    return !issue.pull_request && issue.state?.toLowerCase() === "open" &&
      author.login === "github-actions[bot]" &&
      labels(issue).includes("report") && labels(issue).includes("agentic-factory") &&
      typeof issue.body === "string" && issue.body.includes(marker(series));
  });
  if (candidates.length > 1) {
    return { number: null, reason: "multiple-canonical-reports", marker: marker(series) };
  }
  const issue = candidates[0];
  return {
    number: issue ? issue.number : null,
    reason: issue ? "ok" : "not-yet-published",
    marker: marker(series),
    updatedAt: issue ? issue.updated_at || issue.updatedAt || null : null,
  };
}

function failureReceipt(series, now, reason) {
  return {
    schemaVersion: 1,
    series,
    observedAt: now,
    status: "failed",
    reason,
    completeness: "unavailable",
    metrics: null,
    materialHash: crypto.createHash("sha256").update(`${series}:${reason}`).digest("hex"),
  };
}

function renderReport(receipt) {
  const report = receipt.report;
  const rows = [
    marker(receipt.series),
    `### ${SERIES[receipt.series].prefix.trim()} ${receipt.status}`,
    "",
    `Observed: ${receipt.observedAt}. Collection: ${receipt.completeness}.`,
    `Reason: ${receipt.reason || "collected"}.`,
  ];
  if (receipt.runUrl) rows.push(`Receipt: ${receipt.runUrl}`);
  if (report?.window) rows.push(`Window: ${report.window.start} to ${report.window.end} (UTC, end exclusive).`);
  if (report?.monitoredRun) rows.push(`Monitored workflow: ${report.monitoredRun.workflow}; run ${report.monitoredRun.runId}; ${report.monitoredRun.conclusion || report.monitoredRun.status}.`);
  if (report?.factory) {
    const state = report.factory;
    rows.push("", `Factory: **${state.mode.mode}** (${state.mode.reason}); work: **${state.workState}**.`,
      `Goal: ${state.goals.resolution}; budget used/limit: ${state.capacity.budgetUsed ?? "unknown"}/${state.capacity.budgetLimit ?? "unknown"}; WIP: ${state.capacity.inFlight ?? "unknown"}.`,
      `Block reasons: ${state.blockReasons.join(", ") || "none"}.`);
  }
  if (report?.issues) {
    rows.push("", `Issue churn (not delivery): ${report.issues.openedInWindow ?? "unknown"} opened / ${report.issues.closedInWindow ?? "unknown"} closed.`);
  }
  if (report?.outcomes) {
    rows.push(`Verified substantive dev outcomes: ${report.outcomes.verifiedSubstantive ?? "unknown"}.`,
      `Paper metrics: unknown; synthetic checks do not establish trading edge.`);
  }
  if (report?.thresholds) rows.push(`Thresholds: ${report.thresholds.breaches.map((item) => item.id).join(", ") || "no observed breach (see completeness)"}.`);
  if (report?.summary) rows.push(`Entropy findings: ${report.summary.advisoryFindings}; zero-tolerance: ${report.summary.zeroToleranceFailures}.`);
  if (report?.diffSummary) {
    rows.push(`Human corrections: ${report.diffSummary.mismatch}; pending: ${report.pendingCount}; correction rate: ${report.correctionRate ?? "unknown"}.`);
  }
  if (report?.sources) {
    rows.push("", "### Source completeness");
    for (const [name, value] of Object.entries(report.sources)) {
      rows.push(`- ${name}: ${value.completeness}; ${value.records ?? "unknown"} observed; ${value.reason || "read completed"}.`);
      for (const failure of (value.failures || []).slice(0, 5)) {
        rows.push(`- ${name}/${failure.name}: ${failure.reason}.`);
      }
    }
  }
  rows.push("", `<!-- ${SERIES[receipt.series].hash}: ${receipt.materialHash} -->`);
  return rows.join("\n");
}

async function publishReport({ github, owner, repo, receipt, issues, apply = false }) {
  const identity = canonicalReport(issues, receipt.series);
  if (identity.reason === "multiple-canonical-reports") throw new Error(identity.reason);
  const prior = issues.find((issue) => issue.number === identity.number);
  const body = renderReport(receipt);
  const hashMarker = `<!-- ${SERIES[receipt.series].hash}: ${receipt.materialHash} -->`;
  if (prior?.body?.includes(hashMarker)) return { action: "unchanged", number: prior.number };
  if (!apply) return { action: "preview", number: identity.number, body };
  if (prior) {
    // Re-read the owned destination: never overwrite an issue whose ownership changed.
    const current = (await github.rest.issues.get({ owner, repo, issue_number: prior.number })).data;
    if (canonicalReport([current], receipt.series).number !== prior.number) throw new Error("report-ownership-changed");
    await github.rest.issues.update({ owner, repo, issue_number: prior.number, body });
    return { action: "updated", number: prior.number };
  }
  const created = await github.rest.issues.create({
    owner, repo, title: `${SERIES[receipt.series].prefix}Canonical health`,
    body, labels: ["agentic-factory", "report"],
  });
  return { action: "created", number: created.data.number };
}

async function recordSummary({ core, outputPath }) {
  const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const items = (output.items || []).filter((item) => item.type === "record_summary");
  if (items.length !== 1 || typeof items[0].summary !== "string" ||
      items[0].summary.length === 0 || items[0].summary.length > 8000) {
    throw new Error("invalid-summary-output");
  }
  await core.summary.addHeading("Optional factory summary").addCodeBlock(items[0].summary, "text").write();
}

module.exports = { SERIES, marker, canonicalReport, failureReceipt, renderReport, publishReport, recordSummary };
