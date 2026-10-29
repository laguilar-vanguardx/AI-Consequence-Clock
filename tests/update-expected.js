/*
 * Regenerates the pinned baseline in tests/expected.json and the published
 * artifact in data/summary.json from data/incidents.json.
 *
 *   node tests/update-expected.js
 *
 * Run this only when a data change is intentional. The resulting diff is the
 * review surface: it shows exactly which published totals a record change moved.
 * Run node tests/derive.test.js afterwards.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "js", "evidence.js"));
const { idDigest, contentDigest } = require(path.join(__dirname, "..", "scripts", "content-digest.js"));

const root = path.join(__dirname, "..");
const dataset = JSON.parse(fs.readFileSync(path.join(root, "data", "incidents.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const summary = E.derive(dataset, "2026-09-28");
const headline = dataset.incidents.filter(E.isHeadlineEligible);
const audit = E.provenanceSummary(dataset.incidents);

function axisMap(name) {
  return summary.axes[name].reduce((acc, g) => {
    acc[g.label] = { headline: g.headline, excluded: g.excluded };
    return acc;
  }, {});
}

function money(map) {
  return Object.keys(map).reduce((acc, k) => {
    acc[k] = map[k].amount;
    return acc;
  }, {});
}

const expected = {
  _purpose:
    "Pinned baseline. tests/derive.test.js compares the live derivation against these committed numbers. Recomputing expectations from incidents.json alone cannot detect a record being deleted, because both sides move together. Any change here must be deliberate and must ship in the same commit as the data change, with the reason in the record change_log.",
  _regenerate: "node tests/update-expected.js",
  reviewed: today,
  record_count: summary.record_count,
  headline_count: summary.headline_count,
  headline_ids: summary.headline_ids.slice().sort(),
  documented_occurrences: summary.documented_occurrences,
  demonstrated_capabilities: summary.demonstrated_capabilities,
  agent_caused: summary.agent_caused,
  unauthorized_actions: summary.unauthorized_actions,
  authorization_gap: summary.authorization_gap,
  confirmed_money: money(summary.confirmed_money),
  geography_not_established: summary.geography_unsupported,
  disclosure_lag_average: summary.disclosure_lag_average,
  disclosure_lag_n: summary.disclosure_lag_n,
  // Pin every axis the evidence layer publishes, not a hardcoded four, so a new
  // breakdown is pinned the moment it exists rather than whenever someone remembers.
  axes: Object.keys(summary.axes).reduce((acc, name) => {
    acc[name] = axisMap(name);
    return acc;
  }, {}),
  // Pinned so that annotating a source shows, in review, which verdicts it moved.
  provenance: { verdicts: audit.verdicts, ids: audit.ids },
  sensitivity: E.sensitivityTable(dataset.incidents).map((r) => ({
    id: r.id,
    total: r.total,
    documented: r.documented,
    demonstrated: r.demonstrated,
    ids: r.ids
  }))
};

const published = {
  methodology_version: dataset.methodology_version,
  evidence_layer_version: dataset.evidence_layer_version,
  generated_at: dataset.generated_at,
  last_evidence_review: dataset.last_evidence_review,
  dataset_status: dataset.dataset_status,
  checksum_algorithm: "SHA-256",
  checksum_input: "sorted incident id list, comma-joined",
  record_count: summary.record_count,
  eligible_record_count: summary.headline_count,
  record_ids: summary.headline_ids.slice().sort(),
  dataset_checksum_sha256: idDigest(dataset.incidents),
  content_checksum_input: "SHA-256 of the sorted id:hash lines, one SHA-256 per record over its canonical JSON",
  dataset_content_sha256: contentDigest(dataset.incidents),
  hero_metric: "sourced_cases_lacking_documented_execution_time_authorization",
  hero_count: summary.authorization_gap,
  hero_record_ids: headline.filter(E.isAuthGap).map((r) => r.id),
  occurrence_split: {
    documented_occurrences: summary.documented_occurrences,
    demonstrated_capabilities: summary.demonstrated_capabilities,
    note:
      "Derived from the adversary field. These two are never added together under a label implying an event occurred."
  },
  agent_caused: summary.agent_caused,
  unauthorized_actions: summary.unauthorized_actions,
  confirmed_money: money(summary.confirmed_money),
  geography_not_established: summary.geography_unsupported,
  axes: Object.keys(summary.axes).reduce((acc, k) => {
    acc[k] = summary.axes[k].map((g) => ({
      label: g.label,
      supported: g.supported,
      headline: g.headline,
      excluded: g.excluded
    }));
    return acc;
  }, {}),
  headline_rule: dataset.headline_rule,
  verification: "node tests/derive.test.js"
};

fs.writeFileSync(path.join(__dirname, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
fs.writeFileSync(path.join(root, "data", "summary.json"), JSON.stringify(published, null, 2) + "\n");

console.log("Wrote tests/expected.json and data/summary.json");
console.log(
  "  records " +
    summary.record_count +
    " · headline " +
    summary.headline_count +
    " (" +
    summary.documented_occurrences +
    " documented, " +
    summary.demonstrated_capabilities +
    " demonstrated) · authorization gap " +
    summary.authorization_gap
);
console.log("Review the diff before committing, then run: node tests/derive.test.js");
