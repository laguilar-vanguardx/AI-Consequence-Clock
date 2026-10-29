/*
 * Checks that every provenance quote appears in the archived snapshot it cites.
 *
 *   node scripts/verify-provenance-quotes.js [--base <base incidents.json>] [--cache <file>]
 *
 * Three outcomes per quote, never collapsed, as in tests/find-archives.js: found, not
 * found, or the lookup failed. A failed lookup is retried, then reported as failed; it is
 * never reported as "not found" and nothing is written to the data. The command exits 1
 * only when a quote was looked up and is not in its snapshot.
 *
 * --base checks only the evidence a pull request adds or changes. --cache keeps definite
 * results between runs: a snapshot never changes, so a quote found once stays found.
 * Delete the cache after changing normalizeText, or old "not found" results survive.
 */
"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");
const { sha256 } = require(path.join(__dirname, "content-digest.js"));

const FOUND = "found";
const NOT_FOUND = "not_found";
const FAILED = "failed";
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const PAUSE_MS = 1500;

/* Every evidence entry in the dataset, with where it came from. */
function collectEvidence(dataset) {
  const entries = [];
  ((dataset && dataset.incidents) || []).forEach((record) => {
    (record.sources || []).forEach((source) => {
      const evidence = source && source.provenance && source.provenance.evidence;
      if (!Array.isArray(evidence)) return;
      evidence.forEach((entry) => {
        if (!entry || typeof entry.quote !== "string" || typeof entry.snapshot_url !== "string") return;
        entries.push({
          record: record.id,
          source: source.id,
          supports: entry.supports,
          quote: entry.quote,
          snapshot_url: entry.snapshot_url
        });
      });
    });
  });
  return entries;
}

const keyOf = (entry) => sha256(entry.snapshot_url + "\n" + entry.quote);

/* Entries a pull request adds or changes: those not present, identically, in its base. */
function changedSince(entries, baseEntries) {
  const before = new Set(baseEntries.map(keyOf));
  return entries.filter((entry) => !before.has(keyOf(entry)));
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "..."
};

/*
 * Pages and copied quotes differ in markup, entities, spacing, quote marks and dashes.
 * Those differences are removed from both sides; the words must then match exactly.
 * Removing a tag leaves a space, so spaces before punctuation are dropped too:
 * "<a>Reuters</a>, the" must match "Reuters, the".
 */
function normalizeText(text) {
  return String(text || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const decoded = ENTITIES[name.toLowerCase()];
      return decoded === undefined ? m : decoded;
    })
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?)\]])/g, "$1")
    .replace(/([(\[]) /g, "$1")
    .trim()
    .toLowerCase();
}

/* The raw capture, without the Wayback toolbar: "id_" after the timestamp. */
function rawSnapshotUrl(snapshotUrl) {
  return snapshotUrl.replace(/^(https:\/\/web\.archive\.org\/web\/\d{14})[a-z_]*\//, "$1id_/");
}

/* Resolves { status, body } or rejects; follows up to five redirects. */
function fetchText(url, redirects) {
  const left = redirects === undefined ? 5 : redirects;
  return new Promise((resolve, reject) => {
    const options = { timeout: 60000, headers: { "User-Agent": "ai-consequence-clock-quote-check" } };
    const req = https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).toString(), left - 1));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* One lookup with retries on rate limits and outages. Only a 200 can produce found or not found. */
async function checkOne(entry, io) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response;
    try {
      response = await io.fetchText(rawSnapshotUrl(entry.snapshot_url));
    } catch (err) {
      response = { status: 0, error: err.message };
    }
    if (response.status === 200) {
      const found = normalizeText(response.body).indexOf(normalizeText(entry.quote)) !== -1;
      return { ...entry, state: found ? FOUND : NOT_FOUND };
    }
    const retryable = response.status === 0 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === RETRY_DELAYS_MS.length) {
      return { ...entry, state: FAILED, reason: response.error || "HTTP " + response.status };
    }
    await io.sleep(RETRY_DELAYS_MS[attempt]);
  }
  return { ...entry, state: FAILED, reason: "retries exhausted" };
}

/* One request at a time with a pause between them: archive.org rate-limits aggressively. */
async function checkEntries(entries, io) {
  const cache = io.cache || {};
  const results = [];
  for (const entry of entries) {
    const key = keyOf(entry);
    if (cache[key] === FOUND || cache[key] === NOT_FOUND) {
      results.push({ ...entry, state: cache[key], cached: true });
      continue;
    }
    const result = await checkOne(entry, io);
    if (result.state !== FAILED) cache[key] = result.state;
    results.push(result);
    await io.sleep(PAUSE_MS);
  }
  return { results, cache };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return fallback;
  }
}

async function main(args) {
  const option = (name) => (args.indexOf(name) === -1 ? null : args[args.indexOf(name) + 1]);
  const dataset = readJson(path.join(__dirname, "..", "data", "incidents.json"), null);
  if (!dataset || !Array.isArray(dataset.incidents)) {
    console.log("FAILED: data/incidents.json could not be read.");
    return 2;
  }
  let entries = collectEvidence(dataset);
  if (option("--base")) entries = changedSince(entries, collectEvidence(readJson(option("--base"), null)));
  const cacheFile = option("--cache");
  const cache0 = cacheFile ? readJson(cacheFile, {}) : {};
  const { results, cache } = await checkEntries(entries, { fetchText, sleep, cache: cache0 });
  if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + "\n");
  results.forEach((r) => {
    const where = r.record + " / " + r.source + " (" + r.supports + ")";
    console.log("  " + r.state.padEnd(9) + " " + where + (r.reason ? " - " + r.reason : ""));
  });
  const count = (state) => results.filter((r) => r.state === state).length;
  const totals = [count(FOUND) + " found", count(NOT_FOUND) + " not found", count(FAILED) + " lookup failed"];
  console.log("\n" + entries.length + " quote(s): " + totals.join(", ") + ".");
  return count(NOT_FOUND) ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}

module.exports = {
  collectEvidence,
  changedSince,
  normalizeText,
  rawSnapshotUrl,
  checkEntries,
  FOUND,
  NOT_FOUND,
  FAILED
};
