/*
 * Reference consumer: how another system should decide whether it may rely on a record.
 *
 *   node examples/consumer-policy.js <record-id> [--now YYYY-MM-DD]
 *
 * It denies by default. Reliance is allowed only when every check passes: known versions,
 * real (not demo) data, a recent review, a published summary that matches the data,
 * a counted record, and the single verdict that permits reliance. decide() never reads
 * the clock; `now` is passed in, so the result is reproducible.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "js", "evidence.js"));
const { idDigest, contentDigest } = require(path.join(__dirname, "..", "scripts", "content-digest.js"));

const REASONS = Object.freeze({
  MISSING_INPUT: "MISSING_INPUT",
  UNKNOWN_VERSION: "UNKNOWN_VERSION",
  DEMO_DATA: "DEMO_DATA",
  STALE: "STALE",
  SUMMARY_MISMATCH: "SUMMARY_MISMATCH",
  RECORD_NOT_FOUND: "RECORD_NOT_FOUND",
  NOT_COUNTED: "NOT_COUNTED",
  NOT_CONFIRMED: E.RELIANCE_REASONS.NOT_CONFIRMED,
  PENDING_SOURCES: E.RELIANCE_REASONS.PENDING_SOURCES
});

/* In 0.x versions a minor release may change meaning, so major.minor is the compatibility line. */
const KNOWN_VERSIONS = Object.freeze({
  methodology_version: ["0.2"],
  evidence_layer_version: ["0.1"]
});

const DAY_MS = 86400000;

function versionLine(version) {
  const match = /^(\d+)\.(\d+)/.exec(String(version || ""));
  return match ? match[1] + "." + match[2] : null;
}

const reason = (code, message) => ({ code, message });

function inputProblems(dataset, published, now) {
  const problems = [];
  if (!dataset || !Array.isArray(dataset.incidents)) {
    problems.push(reason(REASONS.MISSING_INPUT, "No readable dataset."));
  }
  if (!published || typeof published !== "object") problems.push(reason(REASONS.MISSING_INPUT, "No readable summary."));
  if (!isFinite(Date.parse(now))) problems.push(reason(REASONS.MISSING_INPUT, "No valid decision date."));
  return problems;
}

function datasetProblems(dataset, published, now, maxAgeDays, knownVersions) {
  const problems = [];
  Object.keys(knownVersions).forEach((field) => {
    if (knownVersions[field].indexOf(versionLine(dataset[field])) === -1) {
      problems.push(reason(REASONS.UNKNOWN_VERSION, field + " " + String(dataset[field]) + " is not a known version."));
    }
  });
  if (dataset.dataset_status === "SEED_DEMO") {
    problems.push(reason(REASONS.DEMO_DATA, "The dataset is marked SEED_DEMO."));
  }
  const age = (Date.parse(now) - Date.parse(dataset.last_evidence_review)) / DAY_MS;
  if (!isFinite(age) || age > maxAgeDays) {
    problems.push(reason(REASONS.STALE, "The last evidence review is older than " + maxAgeDays + " days, or missing."));
  }
  const comparison = E.comparePublishedSummary(E.derive(dataset, now), published, {
    idDigest: idDigest(dataset.incidents),
    contentDigest: contentDigest(dataset.incidents)
  });
  if (comparison.status !== "matches" || typeof published.dataset_content_sha256 !== "string") {
    const fields = comparison.mismatches.length ? comparison.mismatches.join(", ") : "dataset_content_sha256 missing";
    problems.push(reason(REASONS.SUMMARY_MISMATCH, "The published summary does not match the data: " + fields + "."));
  }
  return problems;
}

function recordProblems(dataset, recordId) {
  const record = dataset.incidents.find((r) => r.id === recordId);
  if (!record) return { problems: [reason(REASONS.RECORD_NOT_FOUND, "No record " + recordId + ".")], verdict: null };
  if (!E.isHeadlineEligible(record)) {
    return { problems: [reason(REASONS.NOT_COUNTED, "The record does not enter headline totals.")], verdict: null };
  }
  const decision = E.relianceDecision(E.sourceRoots(record));
  return { problems: decision.reasons, verdict: decision.verdict };
}

/* Every reason that applies is reported, so a denial can be fixed in one pass. */
function decide({ dataset, published, recordId, now, maxAgeDays = 90, knownVersions = KNOWN_VERSIONS }) {
  const missing = inputProblems(dataset, published, now);
  if (missing.length) return { allowed: false, record_id: recordId, verdict: null, reasons: missing };
  const record = recordProblems(dataset, recordId);
  const reasons = datasetProblems(dataset, published, now, maxAgeDays, knownVersions).concat(record.problems);
  return { allowed: reasons.length === 0, record_id: recordId, verdict: record.verdict, reasons };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return null;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--now");
  const root = path.join(__dirname, "..");
  const decision = decide({
    dataset: readJson(path.join(root, "data", "incidents.json")),
    published: readJson(path.join(root, "data", "summary.json")),
    recordId: args[0],
    now: at === -1 ? new Date().toISOString().slice(0, 10) : args[at + 1]
  });
  console.log(JSON.stringify(decision, null, 2));
  process.exitCode = decision.allowed ? 0 : 1;
}

module.exports = { decide, REASONS, KNOWN_VERSIONS, versionLine };
