"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

function hasNextPage(headers, page) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("Pagination response headers missing");
  const values = Object.entries(headers).filter(([name]) => name.toLowerCase() === "link").map(([, value]) => value);
  if (values.length === 0) return false;
  if (values.length !== 1 || typeof values[0] !== "string" || values[0].trim() === "") throw new Error("Ambiguous pagination Link header");
  const relations = new Set();
  for (const part of values[0].split(/,\s*(?=<)/)) {
    const match = /^<([^<>\s]+)>\s*;\s*rel=(?:"(next|prev|first|last)"|(next|prev|first|last))\s*$/.exec(part.trim());
    if (!match) throw new Error("Malformed pagination Link header");
    const relation = match[2] || match[3];
    if (relations.has(relation)) throw new Error("Duplicate pagination relation");
    relations.add(relation);
    const url = new URL(match[1]);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid pagination URL");
    if (relation === "next") {
      const next = url.searchParams.getAll("page");
      if (next.length !== 1 || !/^[1-9]\d*$/.test(next[0]) || Number(next[0]) !== page + 1) {
        throw new Error("Unverifiable pagination progression");
      }
    }
  }
  return relations.has("next");
}

function createReadOnlyReader({ github, owner, repo, maxPages = 20, maxRequests = 1500 }) {
  const reads = [];
  let requests = 0;
  async function request(route, params = {}) {
    if (!route.startsWith("GET ")) throw new Error("Readiness only permits GET requests");
    if (++requests > maxRequests) throw new Error("Readiness request limit reached");
    return github.request(route, { owner, repo, ...params });
  }
  async function get(route, params = {}, { absent404 = false, validate } = {}) {
    const resource = route.replace(/\{(\w+)\}/g, (_, key) => String({ owner, repo, ...params }[key]));
    try {
      const response = await request(route, params);
      if (!response || response.data === undefined || response.data === null) throw new Error("Missing API data");
      if (validate && !validate(response.data)) throw new Error("Malformed API object");
      reads.push({ resource, complete: true, status: response.status || 200 });
      return response.data;
    } catch (error) {
      const absent = absent404 && error.status === 404;
      reads.push({
        resource, complete: absent, status: error.status || null,
        reason: absent ? "absent" : "api-read-failed", error: error.message,
      });
      return absent ? null : undefined;
    }
  }
  async function list(route, params = {}, key, validateItem) {
    const resource = route.replace(/\{(\w+)\}/g, (_, name) => String({ owner, repo, ...params }[name]));
    const items = [];
    let pages = 0;
    let expectedTotal;
    try {
      for (let page = 1; page <= maxPages; page += 1) {
        const response = await request(route, { ...params, per_page: 100, page });
        pages += 1;
        const data = key ? response.data?.[key] : response.data;
        if (!Array.isArray(data) || data.length > 100 ||
          response.data?.incomplete_results !== undefined && response.data.incomplete_results !== false) {
          throw new Error("Malformed or incomplete list response");
        }
        if (data.some((item) => !item || typeof item !== "object" || validateItem && !validateItem(item))) {
          throw new Error("Malformed list item");
        }
        items.push(...data);
        const total = response.data?.total_count;
        if (total !== undefined) {
          if (!Number.isSafeInteger(total) || total < 0 || expectedTotal !== undefined && expectedTotal !== total) {
            throw new Error("Invalid or inconsistent pagination total");
          }
          expectedTotal = total;
        }
        const hasNext = hasNextPage(response.headers, page);
        if (!hasNext) {
          if (expectedTotal !== undefined && items.length !== expectedTotal) throw new Error("Pagination ended before the advertised total");
          reads.push({ resource, complete: true, pages, count: items.length });
          return items;
        }
        if (data.length === 0 || expectedTotal !== undefined && items.length >= expectedTotal) {
          throw new Error("Pagination next link contradicts observed data");
        }
      }
      throw new Error("Pagination limit reached");
    } catch (error) {
      reads.push({
        resource, complete: false, pages, count: items.length,
        status: error.status || null, reason: "api-list-incomplete", error: error.message,
      });
      return items;
    }
  }
  return { get, list, reads };
}

function createGhReadOnlyClient() {
  const execute = promisify(execFile);
  return {
    async request(route, params = {}) {
      if (!route.startsWith("GET ")) throw new Error("Readiness only permits GET requests");
      const used = new Set();
      const endpoint = route.slice(4).replace(/\{(\w+)\}/g, (_, key) => {
        used.add(key);
        if (params[key] === undefined) throw new Error(`Missing route parameter: ${key}`);
        return encodeURIComponent(String(params[key]));
      }).replace(/^\//, "");
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (!used.has(key) && value !== undefined) query.set(key, String(value));
      }
      const args = ["api", "--method", "GET", "--include", "-H", "Accept: application/vnd.github+json",
        `${endpoint}${query.size ? `?${query}` : ""}`];
      let stdout;
      try {
        ({ stdout } = await execute("gh", args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
      } catch (error) {
        const status = /HTTP(?:\/[\d.]+)?\s+(\d{3})/.exec(`${error.stdout || ""}\n${error.stderr || ""}`);
        const failure = new Error(`GitHub GET failed${status ? ` (HTTP ${status[1]})` : ""}`);
        failure.status = status ? Number(status[1]) : undefined;
        throw failure;
      }
      const split = stdout.search(/\r?\n\r?\n/);
      if (split < 0) throw new Error("GitHub response headers missing");
      const headerText = stdout.slice(0, split);
      const body = stdout.slice(split).trim();
      const headers = Object.fromEntries(headerText.split(/\r?\n/).slice(1).map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      return { status: 200, headers, data: JSON.parse(body) };
    },
  };
}

module.exports = { createReadOnlyReader, createGhReadOnlyClient };
