/*
 * The reference consumer must deny by default.
 *
 *   node tests/consumer-policy.test.js
 *
 * One valid synthetic case is allowed. Every other row breaks exactly one condition and
 * must be denied with that condition's reason code.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "js", "evidence.js"));
const { decide, REASONS } = require(path.join(__dirname, "..", "examples", "consumer-policy.js"));
const { contentDigest } = require(path.join(__dirname, "..", "scripts", "content-digest.js"));

const read = (file) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", file), "utf8"));
const dataset = read("incidents.json");
const published = read("summary.json");

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
    console.log("  ok   " + name);
  } else {
    failures.push(name);
    console.log("  FAIL " + name + "\n         expected " + b + "\n         actual   " + a);
  }
}

/* A counted record whose two sources are annotated as independent originals. */
const TARGET = "acc-2024-02-14-air-canada";
const ORIGINAL = { kind: "ORIGINAL", derives_from_internal: [], derives_from_external: [], note: "Fixture." };
function confirmedDataset(base) {
  const copy = JSON.parse(JSON.stringify(base));
  copy.dataset_status = "REVIEWED";
  const record = copy.incidents.find((r) => r.id === TARGET);
  record.sources = record.sources.map((s, i) => ({ ...s, id: "s" + i, provenance: ORIGINAL }));
  return copy;
}
const goodData = confirmedDataset(dataset);
const goodSummary = {
  ...published,
  dataset_status: goodData.dataset_status,
  dataset_content_sha256: contentDigest(goodData.incidents)
};
const REVIEW = goodData.last_evidence_review;
const after = (days) => new Date(Date.parse(REVIEW) + days * 86400000).toISOString().slice(0, 10);
const GOOD = { dataset: goodData, published: goodSummary, recordId: TARGET, now: after(10) };

const codes = (input) => decide({ ...GOOD, ...input }).reasons.map((r) => r.code);

console.log("The valid case");
const target = goodData.incidents.find((r) => r.id === TARGET);
check("the fixture record is confirmed", E.sourceRoots(target).verdict, "INDEPENDENT_CONFIRMED");
check("a fully valid input is allowed", [decide(GOOD).allowed, decide(GOOD).reasons], [true, []]);
check(
  "a patch release of a known version is allowed",
  codes({ dataset: { ...goodData, methodology_version: "0.2.9-preview" } }),
  []
);

console.log("\nEach broken condition denies, with its own reason");
const edited = JSON.parse(JSON.stringify(goodData));
edited.incidents[0].title += " (edited)";
const otherCounted = dataset.incidents.find((r) => E.isHeadlineEligible(r) && r.id !== TARGET).id;
const notCounted = dataset.incidents.find((r) => !E.isHeadlineEligible(r)).id;
const ROWS = [
  ["no dataset", { dataset: null }, [REASONS.MISSING_INPUT]],
  ["no summary", { published: null }, [REASONS.MISSING_INPUT]],
  ["no decision date", { now: "not a date" }, [REASONS.MISSING_INPUT]],
  ["an unknown major version", { dataset: { ...goodData, methodology_version: "1.0.0" } }, [REASONS.UNKNOWN_VERSION]],
  [
    "an unknown minor version",
    { dataset: { ...goodData, evidence_layer_version: "0.2.0" } },
    [REASONS.UNKNOWN_VERSION]
  ],
  ["demo data", { dataset: { ...goodData, dataset_status: "SEED_DEMO" } }, [REASONS.DEMO_DATA]],
  ["a stale review", { now: after(91) }, [REASONS.STALE]],
  ["a record edited after the summary was published", { dataset: edited }, [REASONS.SUMMARY_MISMATCH]],
  [
    "a summary without the content checksum",
    { published: { ...goodSummary, dataset_content_sha256: undefined } },
    [REASONS.SUMMARY_MISMATCH]
  ],
  ["an unknown record", { recordId: "acc-0000-nothing" }, [REASONS.RECORD_NOT_FOUND]],
  ["a record outside the headline totals", { recordId: notCounted }, [REASONS.NOT_COUNTED]],
  [
    "a counted record that is not confirmed",
    { recordId: otherCounted },
    [REASONS.NOT_CONFIRMED, REASONS.PENDING_SOURCES]
  ]
];
ROWS.forEach(([name, input, expected]) => {
  check(name + " is denied", decide({ ...GOOD, ...input }).allowed, false);
  check(name + " gives " + expected.join(" and "), codes(input), expected);
});

console.log("\nReal data and reproducibility");
const today = after(10);
check(
  "every counted record in the real data is denied",
  dataset.incidents
    .filter(E.isHeadlineEligible)
    .filter((r) => decide({ dataset, published, recordId: r.id, now: today }).allowed).length,
  0
);
const realDecision = decide({ dataset, published, recordId: TARGET, now: today });
check("the real data is denied as demo data, not as a mismatch", realDecision.reasons.map((r) => r.code), [
  REASONS.DEMO_DATA,
  REASONS.NOT_CONFIRMED,
  REASONS.PENDING_SOURCES
]);
const clock = Date.now;
Date.now = () => {
  throw new Error("decide() read the clock");
};
let readsClock = false;
try {
  decide(GOOD);
} catch (err) {
  readsClock = true;
} finally {
  Date.now = clock;
}
check("decide() never reads the clock", readsClock, false);

console.log("\n" + "-".repeat(64));
if (failures.length) {
  console.log("FAILED: " + failures.length + " assertion(s) failed, " + passed + " passed.");
  process.exit(1);
}
console.log("PASSED: " + passed + " assertions.");
