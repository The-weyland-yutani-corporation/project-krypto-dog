"use strict";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function normalizeWorkflowPath(value) {
  if (typeof value !== "string") return value;
  return value.replace(/^(.+?\.ya?ml)@refs\/[^/\s]+\/\S+$/, "$1");
}

function source(completeness, records, observedAt, reason = null, total = null) {
  return { completeness, records, total, observedAt, reason };
}

function readJson(runner, args) {
  const result = runner("gh", args);
  if (result.status !== 0) {
    const status = (result.stderr || "").match(/HTTP (\d{3})/);
    throw new Error(status ? `github-http-${status[1]}` : "github-command-failed");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("github-invalid-json");
  }
}

function repositoryName(runner, explicit = process.env.GITHUB_REPOSITORY) {
  const name = explicit || readJson(runner, ["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
  if (typeof name !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(name)) {
    throw new Error("invalid-repository");
  }
  return name;
}

function pageResult(payload, key) {
  const rows = key ? payload && payload[key] : payload;
  if (!Array.isArray(rows)) throw new Error("github-invalid-list");
  return {
    rows,
    total: Number.isSafeInteger(payload && payload.total_count) ? payload.total_count : null,
  };
}

function readPages(runner, endpoint, key, options = {}) {
  const now = options.now || new Date().toISOString();
  const maxPages = options.maxPages || MAX_PAGES;
  const data = [];
  let total = null;
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const separator = endpoint.includes("?") ? "&" : "?";
      const payload = readJson(runner, [
        "api", "--method", "GET", `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`,
      ]);
      const result = pageResult(payload, key);
      total = result.total;
      data.push(...result.rows);
      if (result.rows.length < PAGE_SIZE || (total !== null && data.length >= total)) {
        return { data, source: source("complete", data.length, now, null, total ?? data.length) };
      }
    } catch (error) {
      return {
        data,
        source: source(data.length ? "partial" : "unavailable", data.length, now, error.message, total),
      };
    }
  }
  return { data, source: source("partial", data.length, now, "page-limit-reached", total) };
}

async function readApiPages(github, route, params, options = {}) {
  const now = options.now || new Date().toISOString();
  const data = [];
  let total = null;
  for (let page = 1; page <= (options.maxPages || MAX_PAGES); page += 1) {
    try {
      const response = await github.request(route, { ...params, per_page: PAGE_SIZE, page });
      const result = pageResult(response.data, options.key);
      total = result.total;
      data.push(...result.rows);
      if (result.rows.length < PAGE_SIZE || (total !== null && data.length >= total)) {
        return { data, source: source("complete", data.length, now, null, total ?? data.length) };
      }
    } catch (error) {
      const reason = Number.isInteger(error.status) ? `github-http-${error.status}` : error.message;
      return { data, source: source(data.length ? "partial" : "unavailable", data.length, now, reason, total) };
    }
  }
  return { data, source: source("partial", data.length, now, "page-limit-reached", total) };
}

function requireComplete(result, name) {
  if (result.source.completeness !== "complete") {
    throw new Error(`${name}: ${result.source.reason || result.source.completeness}`);
  }
  return result.data;
}

function createGhClient(runner) {
  return {
    async request(route, params = {}) {
      if (!route.startsWith("GET ")) throw new Error("read-only-client");
      const used = new Set();
      const endpoint = route.slice(4).replace(/\{(\w+)\}/g, (_, key) => {
        used.add(key);
        return encodeURIComponent(String(params[key]));
      });
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (!used.has(key) && value !== undefined) query.set(key, String(value));
      }
      const suffix = query.size ? `${endpoint.includes("?") ? "&" : "?"}${query}` : "";
      try {
        return { data: readJson(runner, ["api", "--method", "GET", `${endpoint}${suffix}`]) };
      } catch (error) {
        const status = error.message.match(/^github-http-(\d+)$/);
        if (status) error.status = Number(status[1]);
        throw error;
      }
    },
  };
}

module.exports = { PAGE_SIZE, MAX_PAGES, normalizeWorkflowPath, source, readJson, repositoryName, readPages, readApiPages, requireComplete, createGhClient };
