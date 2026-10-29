/*
 * Source provenance tests.
 *
 *   node tests/provenance.test.js
 *
 * The headline rule asks for independently published sources and checks publisher
 * names. Two newsrooms restating one vendor advisory pass that check and are one root
 * of evidence. These tests pin the root count against fixtures whose answer is known
 * by construction, then check the properties that must hold for any record.
 *
 * Every annotated source in this file is a fixture. Nothing here writes provenance
 * onto a real record: that is a human judgement, made one cited edge at a time.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "js", "evidence.js"));
const V = require(path.join(__dirname, "validate-records.js"));
const os = require("os");
const { execFileSync } = require("child_process");

const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "incidents.json"), "utf8"));

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

function ok(name, condition) {
  check(name, !!condition, true);
}

/* ---------------------------------------------------------------- fixtures */

const ORIGINAL = () => ({ kind: "ORIGINAL", derives_from_internal: [], derives_from_external: [], note: null });
const UNKNOWN = () => ({ kind: "UNKNOWN", derives_from_internal: [], derives_from_external: [], note: null });
const derived = (internal, external) => ({
  kind: "DERIVED",
  derives_from_internal: internal,
  derives_from_external: external,
  note: "Fixture: the article names its source in the first paragraph."
});

const SECONDARY = "INDEPENDENT_SECONDARY";
const CVE_ROOT = ["cve:CVE-2024-0001"];

/*
 * The validator requires a quote and an archived snapshot for every claim, and a
 * registered key for every outside origin. Fixtures here test the graph, so they get
 * well-formed evidence and a test registry added; the evidence rules have their own section.
 */
const TEST_REGISTRY = {
  roots: Object.fromEntries(
    ["cve:cve-2024-0001", "cve:cve-2026-0001", "vendor:acme-advisory", "paper:example-2026"].map((key) => [
      key,
      { title: "Fixture origin " + key, url: "https://origin.example/" + key.replace(":", "/") }
    ])
  )
};
const QUOTE = "Fixture quote copied from the archived source page.";
const snapshotOf = (url) => "https://web.archive.org/web/20260101000000/" + url;
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
function withEvidence(sources) {
  return sources.map((s) => {
    const p = s && s.provenance;
    if (!p || typeof p !== "object" || p.evidence !== undefined || (p.kind !== "ORIGINAL" && p.kind !== "DERIVED")) {
      return s;
    }
    const claims =
      p.kind === "ORIGINAL" ? ["original"] : strings(p.derives_from_internal).concat(strings(p.derives_from_external));
    const basis = p.kind === "ORIGINAL" && p.original_basis === undefined ? { original_basis: "OWN_REPORTING" } : {};
    const evidence = claims.map((claim) => ({ supports: claim, quote: QUOTE, snapshot_url: snapshotOf(s.url) }));
    return { ...s, provenance: { ...p, ...basis, evidence } };
  });
}
const validate = (db) => V.validateDataset(db, { registry: TEST_REGISTRY });

function source(id, publisher, url, grade, provenance) {
  const s = {
    id,
    url,
    publisher,
    title: "Fixture source " + id,
    publication_date: "2026-01-02",
    source_type: grade === "ROUNDUP" ? "security_research_roundup" : "news",
    evidence_grade: grade
  };
  if (provenance) s.provenance = provenance;
  return s;
}

const FIXTURES = [
  {
    name: "f1 two clean roots",
    sources: [
      source("tribunal", "Example Tribunal", "https://tribunal.example/decision/1", "PRIMARY", ORIGINAL()),
      source("regulator", "Example Regulator", "https://regulator.example/notice/7", "PRIMARY", ORIGINAL())
    ],
    want: { verdict: "INDEPENDENT_CONFIRMED", component_count: 2, distinct_publisher_count: 2 }
  },
  {
    name: "f2 collapse by internal citation",
    sources: [
      source("wire", "Example Wire", "https://wire.example/a", SECONDARY, ORIGINAL()),
      source("daily", "Example Daily", "https://daily.example/b", SECONDARY, derived(["wire"], []))
    ],
    want: { verdict: "SINGLE_ROOT", component_count: 1, distinct_publisher_count: 2 }
  },
  {
    name: "f3 collapse by shared external root",
    sources: [
      source("wire", "Example Wire", "https://wire.example/a", SECONDARY, derived([], CVE_ROOT)),
      source("daily", "Example Daily", "https://daily.example/b", SECONDARY, derived([], CVE_ROOT))
    ],
    want: { verdict: "SINGLE_ROOT", component_count: 1, distinct_publisher_count: 2 }
  },
  {
    name: "f4 same publisher",
    sources: [
      source("blog", "Example  Labs", "https://blog.example/post", SECONDARY, ORIGINAL()),
      source("paper", " example labs ", "https://papers.example/1", SECONDARY, ORIGINAL())
    ],
    want: { verdict: "SINGLE_ROOT", component_count: 1, distinct_publisher_count: 1 }
  },
  {
    name: "f5 contaminated by UNKNOWN",
    sources: [
      source("wire", "Example Wire", "https://wire.example/a", SECONDARY, ORIGINAL()),
      source("daily", "Example Daily", "https://daily.example/b", SECONDARY, null)
    ],
    want: { verdict: "INDETERMINATE", component_count: 2, distinct_publisher_count: 2 }
  },
  {
    name: "f6 bridge through a non-qualifying source",
    sources: [
      source("tribunal", "Example Tribunal", "https://tribunal.example/decision/1", "PRIMARY", ORIGINAL()),
      source("regulator", "Example Regulator", "https://regulator.example/7", "PRIMARY", derived(["roundup"], [])),
      source("roundup", "Example Roundup", "https://roundup.example/list", "ROUNDUP", derived(["tribunal"], []))
    ],
    want: { verdict: "SINGLE_ROOT", component_count: 1, distinct_publisher_count: 2 }
  },
  {
    name: "f7 no qualifying sources",
    sources: [
      source("roundup", "Example Roundup", "https://roundup.example/list", "ROUNDUP", ORIGINAL()),
      source("mirror", "Example Mirror", "https://mirror.example/list", "ROUNDUP", ORIGINAL())
    ],
    want: { verdict: "NO_QUALIFYING_SOURCES", component_count: 0, distinct_publisher_count: 0 }
  },
  {
    name: "derived from an unannotated roundup",
    sources: [
      source("tribunal", "Example Tribunal", "https://tribunal.example/decision/1", "PRIMARY", ORIGINAL()),
      source("daily", "Example Daily", "https://daily.example/b", SECONDARY, derived(["roundup"], [])),
      source("roundup", "Example Roundup", "https://roundup.example/list", "ROUNDUP", null)
    ],
    want: { verdict: "INDETERMINATE", component_count: 2, distinct_publisher_count: 2 }
  },
  {
    name: "an unannotated roundup nothing cites does not block the verdict",
    sources: [
      source("tribunal", "Example Tribunal", "https://tribunal.example/decision/1", "PRIMARY", ORIGINAL()),
      source("regulator", "Example Regulator", "https://regulator.example/notice/7", "PRIMARY", ORIGINAL()),
      source("roundup", "Example Roundup", "https://roundup.example/list", "ROUNDUP", null)
    ],
    want: { verdict: "INDEPENDENT_CONFIRMED", component_count: 2, distinct_publisher_count: 2 }
  },
  {
    name: "same host under different publisher strings",
    sources: [
      source("page", "NVD", "https://nvd.example/vuln/detail/1", "PRIMARY", ORIGINAL()),
      source("api", "National Vulnerability Database", "https://user@www.NVD.example:443/rest/1", "PRIMARY", ORIGINAL())
    ],
    want: { verdict: "SINGLE_ROOT", component_count: 1, distinct_publisher_count: 2 }
  },
  {
    name: "CVE record plus an entry derived from that record",
    sources: [
      source("cve", "Example CVE Program", "https://cve.example/api/cve/1", "PRIMARY", ORIGINAL()),
      source("enrichment", "Example Vuln Database", "https://vulndb.example/rest/1", "PRIMARY", derived(["cve"], []))
    ],
    want: { verdict: "SINGLE_ROOT", component_count: 1, distinct_publisher_count: 2 }
  },
  {
    name: "two reports cited by one roundup stay two roots",
    sources: [
      source("tribunal", "Example Tribunal", "https://tribunal.example/decision/1", "PRIMARY", ORIGINAL()),
      source("regulator", "Example Regulator", "https://regulator.example/7", "PRIMARY", ORIGINAL()),
      source(
        "roundup",
        "Example Roundup",
        "https://roundup.example/list",
        "ROUNDUP",
        derived(["tribunal", "regulator"], [])
      )
    ],
    want: { verdict: "INDEPENDENT_CONFIRMED", component_count: 2, distinct_publisher_count: 2 }
  },
  {
    name: "two articles copying one roundup are one root",
    sources: [
      source("daily", "Example Daily", "https://daily.example/a", SECONDARY, derived(["roundup"], [])),
      source("weekly", "Example Weekly", "https://weekly.example/b", SECONDARY, derived(["roundup"], [])),
      source("roundup", "Example Roundup", "https://roundup.example/list", "ROUNDUP", ORIGINAL())
    ],
    want: { verdict: "SINGLE_ROOT", component_count: 1, distinct_publisher_count: 2 }
  },
  {
    name: "two outside origins joined only by a roundup stay two",
    sources: [
      source("daily", "Example Daily", "https://daily.example/a", SECONDARY, derived([], ["cve:x"])),
      source("weekly", "Example Weekly", "https://weekly.example/b", SECONDARY, derived([], ["cve:y"])),
      source(
        "roundup",
        "Example Roundup",
        "https://roundup.example/list",
        "ROUNDUP",
        derived([], ["cve:x", "cve:y"])
      )
    ],
    want: { verdict: "INDEPENDENT_CONFIRMED", component_count: 2, distinct_publisher_count: 2 }
  },
  {
    name: "two citers from one aggregator do not join the reports they cite",
    sources: [
      source("tribunal", "Example Tribunal", "https://tribunal.example/decision/1", "PRIMARY", ORIGINAL()),
      source("regulator", "Example Regulator", "https://regulator.example/7", "PRIMARY", ORIGINAL()),
      source("list-a", "Example Aggregator", "https://agg-a.example/1", "ROUNDUP", derived(["tribunal"], [])),
      source("list-b", "Example Aggregator", "https://agg-b.example/2", "ROUNDUP", derived(["regulator"], []))
    ],
    want: { verdict: "INDEPENDENT_CONFIRMED", component_count: 2, distinct_publisher_count: 2 }
  },
  {
    name: "a copy of a roundup from the same outlet as a report is one root with it",
    sources: [
      source("report", "Example Wire", "https://wire.example/report", "PRIMARY", ORIGINAL()),
      source("digest", "Example Wire", "https://digest.example/list", "ROUNDUP", ORIGINAL()),
      source("daily", "Example Daily", "https://daily.example/a", "PRIMARY", derived(["digest"], []))
    ],
    want: { verdict: "SINGLE_ROOT", component_count: 1, distinct_publisher_count: 2 }
  },
  {
    name: "two copies of an unannotated roundup are one root, not yet known",
    sources: [
      source("daily", "Example Daily", "https://daily.example/a", SECONDARY, derived(["roundup"], [])),
      source("weekly", "Example Weekly", "https://weekly.example/b", SECONDARY, derived(["roundup"], [])),
      source("roundup", "Example Roundup", "https://roundup.example/list", "ROUNDUP", null)
    ],
    want: { verdict: "INDETERMINATE", component_count: 1, distinct_publisher_count: 2 }
  }
];

const pick = (roots) => ({
  verdict: roots.verdict,
  component_count: roots.component_count,
  distinct_publisher_count: roots.distinct_publisher_count
});

console.log("Known-answer fixtures");
FIXTURES.forEach((f) => {
  check(f.name, pick(E.sourceRoots({ id: "fixture", sources: f.sources })), f.want);
});

/* The validator's CORROBORATED check counts publisher names, so f3 passes it with one root. */
const f3 = FIXTURES[2];
const corroborated = dataset.incidents.find((r) => r.verification_status === "CORROBORATED");
check(
  "the validator accepts f3's sources on a CORROBORATED record",
  validate({ ...dataset, incidents: [{ ...corroborated, sources: withEvidence(f3.sources) }] }).problems,
  []
);
check(
  "f3 names its shared root",
  E.sourceRoots({ id: "fixture", sources: f3.sources }).components[0].external_roots,
  ["cve:cve-2024-0001"]
);
check(
  "external keys match without regard to case",
  E.sourceRoots({
    id: "fixture",
    sources: [
      source("wire", "Example Wire", "https://wire.example/a", "PRIMARY", derived([], ["cve:CVE-2024-0001"])),
      source("daily", "Example Daily", "https://daily.example/b", "PRIMARY", derived([], ["cve:cve-2024-0001"]))
    ]
  }).component_count,
  1
);

console.log("\nAnnotation coverage");
const coverageOf = (fixture) => {
  const roots = E.sourceRoots({ id: "fixture", sources: fixture.sources });
  return [roots.qualifying_source_count, roots.annotated_qualifying_count, roots.pending_sources.length];
};
check("f2: two qualifying sources, both annotated, none pending", coverageOf(FIXTURES[1]), [2, 2, 0]);
check("f5: two qualifying sources, one annotated, one pending", coverageOf(FIXTURES[4]), [2, 1, 1]);
check("f7: no qualifying sources, nothing pending", coverageOf(FIXTURES[6]), [0, 0, 0]);
check(
  "components list their sources by id",
  E.sourceRoots({ id: "fixture", sources: FIXTURES[0].sources }).components.map((c) => c.sources),
  [["regulator"], ["tribunal"]]
);
check("the record id is carried", E.sourceRoots({ id: "x" }).id, "x");
check("the record id is null when there is none", E.sourceRoots({}).id, null);

/* A DERIVED source whose root cannot be found must never count as an annotated root. */
console.log("\nUnresolved derivations");
const anchor = source("a", "Example Tribunal", "https://tribunal.example/decision/1", "PRIMARY", ORIGINAL());
const UNRESOLVED = [
  ["a reference to a source that is not attached", { kind: "DERIVED", derives_from_internal: ["nowhere"] }],
  ["DERIVED with both lists empty", { kind: "DERIVED", derives_from_internal: [], derives_from_external: [] }],
  ["DERIVED with no lists", { kind: "DERIVED" }],
  ["a reference given as a string", { kind: "DERIVED", derives_from_internal: "a" }],
  ["a reference in the wrong case", { kind: "DERIVED", derives_from_internal: ["A"] }],
  ["a kind in the wrong case", { kind: "original" }],
  ["provenance that is not an object", "ORIGINAL"]
];
UNRESOLVED.forEach(([name, provenance]) => {
  const other = source("b", "Example Regulator", "https://regulator.example/7", "PRIMARY", provenance);
  const verdict = E.sourceRoots({ sources: [anchor, other] }).verdict;
  check(name + " leaves the record INDETERMINATE", verdict, "INDETERMINATE");
});
const regulator = (provenance) =>
  source("b", "Example Regulator", "https://regulator.example/7", "PRIMARY", provenance);
const third = (provenance) => source("c", "Example Daily", "https://daily.example/b", "PRIMARY", provenance);
const CONTRADICTORY = [
  [
    "an ORIGINAL source that lists a derivation",
    [anchor, regulator({ kind: "ORIGINAL", derives_from_internal: ["a"] })]
  ],
  ["a source derived only from itself", [anchor, regulator(derived(["b"], []))]],
  ["two sources derived only from each other", [anchor, regulator(derived(["c"], [])), third(derived(["b"], []))]]
];
CONTRADICTORY.forEach(([name, sources]) => {
  check(name + " leaves the record INDETERMINATE", E.sourceRoots({ sources }).verdict, "INDETERMINATE");
});
const listedOnOriginal = { kind: "ORIGINAL", derives_from_internal: ["a"], derives_from_external: [] };
check(
  "references listed on an ORIGINAL source create no link",
  E.sourceRoots({
    sources: [anchor, source("b", "Example Regulator", "https://regulator.example/7", "PRIMARY", listedOnOriginal)]
  }).component_count,
  2
);

check(
  "every verdict has a label and a description, and an unknown one has neither",
  E.PROVENANCE_VERDICTS.map((v) => !!E.verdictDefinition(v).label && !!E.verdictDefinition(v).text)
    .concat([E.verdictDefinition("NOT_A_VERDICT")]),
  [true, true, true, true, null]
);

console.log("\nMalformed input");
const EMPTY = { verdict: "NO_QUALIFYING_SOURCES", component_count: 0, distinct_publisher_count: 0 };
check("a null record has no roots", pick(E.sourceRoots(null)), EMPTY);
check("a record with no sources has no roots", pick(E.sourceRoots({})), EMPTY);
check("sources that is not an array is ignored", pick(E.sourceRoots({ sources: "abc" })), EMPTY);
check(
  "null entries in sources are skipped",
  pick(E.sourceRoots({ sources: [null, FIXTURES[0].sources[0], "junk", FIXTURES[0].sources[1]] })),
  FIXTURES[0].want
);
const nameless = [
  { url: "https://a.example/1", evidence_grade: "PRIMARY", provenance: ORIGINAL() },
  { url: "https://b.example/1", evidence_grade: "PRIMARY", provenance: ORIGINAL() }
];
check(
  "qualifying sources with no publisher are counted apart and reported",
  ["distinct_publisher_count", "missing_publisher_count"].map((field) => E.sourceRoots({ sources: nameless })[field]),
  [2, 2]
);
const twins = [
  { publisher: "Alpha", evidence_grade: "PRIMARY" },
  { publisher: "Beta", evidence_grade: "ROUNDUP" }
];
check(
  "sources with neither id nor url still give an order-independent result",
  E.sourceRoots({ sources: twins.slice().reverse() }),
  E.sourceRoots({ sources: twins })
);

/* -------------------------------------------------------------- properties */

/* Seeded generator. One record per seed, so a failure names the seed that reproduces it. */
function makeRandom(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (n) => Math.floor(random() * n);
}

const PUBLISHERS = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
const HOSTS = ["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"];
const GRADES = ["ROUNDUP", "INDEPENDENT_SECONDARY", "PRIMARY"];
const EXTERNAL = ["cve:cve-2026-0001", "vendor:acme-advisory", "paper:example-2026"];

function randomSources(next) {
  const sources = [];
  const n = next(7);
  for (let i = 0; i < n; i++) {
    const roll = next(4);
    let provenance = null;
    if (roll === 1) provenance = ORIGINAL();
    if (roll === 2) provenance = UNKNOWN();
    if (roll === 3) {
      // Internal references point only at earlier sources, so the graph stays acyclic.
      const internal = i > 0 && next(2) ? ["s" + next(i)] : [];
      const external = internal.length === 0 || next(2) ? [EXTERNAL[next(EXTERNAL.length)]] : [];
      provenance = derived(internal, external);
    }
    sources.push(
      source(
        "s" + i,
        PUBLISHERS[next(PUBLISHERS.length)],
        "https://" + HOSTS[next(HOSTS.length)] + "/doc/" + i,
        GRADES[next(GRADES.length)],
        provenance
      )
    );
  }
  return sources;
}

/* A record the headline branch of the validator does not inspect, so only provenance is under test. */
const shell = dataset.incidents.find((r) => !E.isHeadlineEligible(r));
/* The record's grade must be the best grade among its sources, so the shell takes it from them. */
const bestGrade = (sources) =>
  ["PRIMARY", "INDEPENDENT_SECONDARY", "ROUNDUP"].find((grade) => sources.some((s) => s.evidence_grade === grade));
const asRawDataset = (sources) => ({
  ...dataset,
  incidents: [{ ...shell, verification_status: "REPORTED", evidence_grade: bestGrade(sources), sources }]
});
const asDataset = (sources) => asRawDataset(withEvidence(sources));

const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);
const CASES = SEEDS.map((seed) => ({ seed, sources: randomSources(makeRandom(seed)) }));
const rootsOf = (sources) => E.sourceRoots({ id: "generated", sources });

/* Reports the seeds that break a property, so the failing record can be rebuilt exactly. */
function holds(name, property) {
  const failing = CASES.filter((c) => !property(c.sources, c.seed)).map((c) => c.seed);
  check(name + " (failing seeds)", failing, []);
}

console.log("\nProperties over " + CASES.length + " generated records, seeds 1 to " + SEEDS.length);
holds("every generated record with a source passes the validator", (sources) =>
  sources.length === 0 || validate(asDataset(sources)).problems.length === 0
);
ok(
  "the generator reaches every verdict",
  E.PROVENANCE_VERDICTS.every((v) => CASES.some((c) => rootsOf(c.sources).verdict === v))
);
holds("component_count never exceeds distinct_publisher_count", (sources) =>
  rootsOf(sources).component_count <= rootsOf(sources).distinct_publisher_count
);
holds("component_count is at least 1 exactly when a qualifying source exists", (sources) =>
  (rootsOf(sources).component_count >= 1) === sources.some((s) => s.evidence_grade !== "ROUNDUP")
);
holds("reordering sources changes nothing", (sources) => {
  const base = JSON.stringify(rootsOf(sources));
  const rotated = sources.slice(1).concat(sources.slice(0, 1));
  const reversed = sources.slice().reverse();
  return base === JSON.stringify(rootsOf(reversed)) && base === JSON.stringify(rootsOf(rotated));
});
holds("with every annotation removed, any record with a qualifying source is INDETERMINATE", (sources) => {
  const roots = rootsOf(sources.map((s) => ({ ...s, provenance: undefined })));
  return roots.qualifying_source_count === 0 || roots.verdict === "INDETERMINATE";
});
holds("the same holds when every source is explicitly UNKNOWN", (sources) => {
  const roots = rootsOf(sources.map((s) => ({ ...s, provenance: UNKNOWN() })));
  return roots.qualifying_source_count === 0 || roots.verdict === "INDETERMINATE";
});
holds("a confirmed or single-root verdict never rests on an unannotated source", (sources) => {
  const roots = rootsOf(sources);
  const settled = roots.verdict === "INDEPENDENT_CONFIRMED" || roots.verdict === "SINGLE_ROOT";
  return !settled || roots.pending_sources.length === 0;
});

/* Attaching more coverage of evidence already on the record cannot raise the count. */
const addition = (grade, target) =>
  source("added", "Brand New Publisher", "https://brand-new.example/x", grade, derived([target.id], []));
holds("adding a source DERIVED from an attached source never raises component_count", (sources, seed) =>
  sources.length === 0 ||
  GRADES.every((grade) => {
    const target = sources[seed % sources.length];
    // The target's own component already counts, or the addition does not qualify either.
    if (target.evidence_grade === "ROUNDUP" && grade !== "ROUNDUP") return true;
    return rootsOf(sources.concat([addition(grade, target)])).component_count <= rootsOf(sources).component_count;
  })
);
/* The property's limit: a root nothing else cites is a new root. */
const unrelated = source(
  "added",
  "Brand New Publisher",
  "https://brand-new.example/x",
  "PRIMARY",
  derived([], ["paper:unrelated-2026"])
);
check(
  "a qualifying source derived only from a root nothing else cites is a new root",
  rootsOf(FIXTURES[0].sources.concat([unrelated])).component_count,
  3
);

const generatedRecords = CASES.map(({ seed, sources }) => ({
  id: "generated-" + seed,
  verification_status: "VERIFIED",
  evidence_grade: "PRIMARY",
  sources
}));
const generatedSummary = E.provenanceSummary(generatedRecords);
check(
  "the four verdict buckets sum to the counted records",
  E.PROVENANCE_VERDICTS.reduce((sum, v) => sum + generatedSummary.verdicts[v], 0),
  generatedSummary.total
);
const idsByVerdict = (verdict) =>
  generatedRecords
    .filter((r) => E.sourceRoots(r).verdict === verdict)
    .map((r) => r.id)
    .sort();
E.PROVENANCE_VERDICTS.forEach((verdict) => {
  check(verdict + " lists its record ids, sorted", generatedSummary.ids[verdict], idsByVerdict(verdict));
});
const emptySummary = E.provenanceSummary([]);
check("an empty set summarizes to zeros", [emptySummary.total, emptySummary.qualifying_source_count], [0, 0]);
check("a missing record list summarizes like an empty one", E.provenanceSummary(null), emptySummary);
const summed = (read) => generatedRecords.reduce((sum, r) => sum + read(E.sourceRoots(r)), 0);
const SUMMED = [
  ["pending sources", generatedSummary.pending_source_count, (r) => r.pending_sources.length],
  ["qualifying sources", generatedSummary.qualifying_source_count, (r) => r.qualifying_source_count],
  ["annotated qualifying sources", generatedSummary.annotated_qualifying_count, (r) => r.annotated_qualifying_count]
];
SUMMED.forEach(([what, total, read]) => check("the summary adds up " + what, total, summed(read)));
ok("the generated set has annotated qualifying sources to add up", generatedSummary.annotated_qualifying_count > 0);
check(
  "the summary reports qualifying sources that have no publisher",
  E.provenanceSummary([{ id: "x", verification_status: "VERIFIED", evidence_grade: "PRIMARY", sources: nameless }])
    .missing_publisher_count,
  2
);

/*
 * A source that only cites others, is not evidence and shares no outlet is a reader of
 * the evidence, not part of it. Adding one must change nothing.
 */
const citer = (sources, seed) => {
  const picks = sources.filter((s, i) => (seed + i) % 2 === 0).map((s) => s.id);
  return source("citer", "Unrelated Roundup", "https://unrelated-roundup.example/list", "ROUNDUP", derived(picks, []));
};
holds("adding a source that only cites others changes neither the verdict nor the count", (sources, seed) => {
  if (sources.length < 2) return true;
  const before = rootsOf(sources);
  const after = rootsOf(sources.concat([citer(sources, seed)]));
  return before.verdict === after.verdict && before.component_count === after.component_count;
});

/* ---------------------------------------------------------------- scale */

console.log("\nScale");
/* One record with n sources: shared publishers and hosts, derivation chains and outside roots. */
function wideRecord(n) {
  const sources = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 5;
    const provenance =
      kind === 0 ? ORIGINAL() : kind === 4 ? derived([], ["cve:k" + (i % 40)]) : derived(["w" + (i - 1 - (i % 3))], []);
    sources.push(
      source("w" + i, "Publisher " + (i % 97), "https://h" + (i % 89) + ".example/" + i, GRADES[i % 3], provenance)
    );
  }
  return { id: "wide", sources };
}

/*
 * Counts the elements that array scans and copies touch, without timers, so the test is
 * the same on every machine. Linear code does about twice the work for twice the input.
 */
function arrayWork(run) {
  const names = ["indexOf", "lastIndexOf", "includes", "shift", "unshift", "splice", "concat"];
  const saved = names.map((name) => Array.prototype[name]);
  let work = 0;
  names.forEach((name, i) => {
    Array.prototype[name] = function () {
      work += this.length;
      return saved[i].apply(this, arguments);
    };
  });
  try {
    run();
  } finally {
    names.forEach((name, i) => (Array.prototype[name] = saved[i]));
  }
  return work;
}
const small = arrayWork(() => E.sourceRoots(wideRecord(2000)));
const large = arrayWork(() => E.sourceRoots(wideRecord(4000)));
ok(
  "doubling the sources at most doubles the scanning work (" + small + " -> " + large + ")",
  large <= 2.2 * small + 1000
);

const chain = [];
for (let i = 0; i < 50000; i++) {
  const provenance = i ? derived(["c" + (i - 1)], []) : ORIGINAL();
  chain.push(source("c" + i, "Publisher " + i, "https://c" + i + ".example/x", "PRIMARY", provenance));
}
check(
  "a chain of 50,000 derivations is walked without running out of stack",
  E.sourceRoots({ sources: chain }).verdict,
  "SINGLE_ROOT"
);

const wide = wideRecord(3000);
check(
  "a large record gives the same result in any source order",
  JSON.stringify(E.sourceRoots({ id: "wide", sources: wide.sources.slice().reverse() })),
  JSON.stringify(E.sourceRoots(wide))
);

console.log("\nPinned baseline (tests/expected.json)");
const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, "expected.json"), "utf8")).provenance;
const liveAudit = E.provenanceSummary(dataset.incidents);
check("pinned verdict counts", liveAudit.verdicts, pinned.verdicts);
check("pinned record ids per verdict", liveAudit.ids, pinned.ids);

/* ------------------------------------------------------- fail-closed reliance */

console.log("\nFail-closed reliance");
E.PROVENANCE_VERDICTS.forEach((verdict) => {
  const expected = verdict === "INDEPENDENT_CONFIRMED";
  check(verdict + ": isConfirmed only for INDEPENDENT_CONFIRMED", E.isConfirmed(verdict), expected);
});
const NOT_VERDICTS = [
  "FUTURE_STATE",
  "independent_confirmed",
  " INDEPENDENT_CONFIRMED",
  "",
  null,
  undefined,
  true,
  1,
  {},
  []
];
check(
  "anything that is not exactly INDEPENDENT_CONFIRMED is not confirmed",
  NOT_VERDICTS.map((value) => E.isConfirmed(value)),
  NOT_VERDICTS.map(() => false)
);
check("a whole sourceRoots result is not a verdict", E.isConfirmed(rootsOf(FIXTURES[0].sources)), false);

const confirmedFixture = FIXTURES[0];
check("the confirmed fixture is relied on", E.relianceDecision(rootsOf(confirmedFixture.sources)), {
  allowed: true,
  verdict: "INDEPENDENT_CONFIRMED",
  reasons: []
});
confirmedFixture.sources.forEach((s, i) => {
  const stripped = confirmedFixture.sources.map((x, j) => (j === i ? { ...x, provenance: undefined } : x));
  const decision = E.relianceDecision(rootsOf(stripped));
  check("removing the provenance of " + s.id + " withdraws reliance", decision.allowed, false);
});
const pendingDecision = E.relianceDecision(rootsOf(FIXTURES[4].sources));
check(
  "an undetermined record says why, with stable codes and the sources to annotate",
  [pendingDecision.allowed, pendingDecision.reasons.map((r) => r.code), pendingDecision.reasons[1].sources],
  [false, ["NOT_CONFIRMED", "PENDING_SOURCES"], ["daily"]]
);
check("a missing result is not relied on", E.relianceDecision(null).allowed, false);
const futureDecision = E.relianceDecision({ verdict: "FUTURE_STATE" });
check("a result with an unknown verdict is not relied on", futureDecision.allowed, false);
check(
  "no real counted record can be relied on yet",
  dataset.incidents.filter(E.isHeadlineEligible).filter((r) => E.relianceDecision(E.sourceRoots(r)).allowed).length,
  0
);

const frozen = (list) => {
  try {
    list.push("FUTURE_STATE");
  } catch (err) {
    return list.indexOf("FUTURE_STATE") === -1;
  }
  return false;
};
ok("the verdict list cannot be extended at runtime", frozen(E.PROVENANCE_VERDICTS));
const confirmedDefinition = E.verdictDefinition("INDEPENDENT_CONFIRMED");
ok("a verdict definition cannot be rewritten at runtime", Object.isFrozen(confirmedDefinition));
ok("the reason codes cannot be changed at runtime", Object.isFrozen(E.RELIANCE_REASONS));

/* ------------------------------------------------------------ real dataset */

console.log("\nReal dataset");
const records = dataset.incidents;
const live = E.provenanceSummary(records);
check("the shadow metric covers exactly the counted records", live.total, records.filter(E.isHeadlineEligible).length);
check(
  "live verdict buckets sum to the counted records",
  E.PROVENANCE_VERDICTS.reduce((sum, v) => sum + live.verdicts[v], 0),
  live.total
);
records.forEach((r) => {
  const roots = E.sourceRoots(r);
  const unannotated = r.sources.some(
    (s) => E.HEADLINE_GRADES.includes(s.evidence_grade) && (!s.provenance || s.provenance.kind === "UNKNOWN")
  );
  const reversed = { ...r, sources: r.sources.slice().reverse() };
  if (unannotated) check(r.id + ": an unannotated qualifying source is INDETERMINATE", roots.verdict, "INDETERMINATE");
  ok(r.id + ": roots do not exceed publishers", roots.component_count <= roots.distinct_publisher_count);
  check(
    r.id + ": a counted component exactly when a qualifying source exists",
    roots.component_count >= 1,
    roots.qualifying_source_count >= 1
  );
  check(r.id + ": source order does not matter", E.sourceRoots(reversed), roots);
});
const before = JSON.stringify(E.derive(dataset, "2026-09-28"));
E.provenanceSummary(records);
check("computing provenance leaves derive() untouched", JSON.stringify(E.derive(dataset, "2026-09-28")), before);
ok("derive() publishes no provenance figure", !/provenance|component_count/i.test(before));

console.log("\nReport script");
const REPORT = path.join(__dirname, "..", "scripts", "provenance-report.js");
const runReport = (args) => execFileSync(process.execPath, [REPORT].concat(args || []), { encoding: "utf8" });
const report = runReport();
check("two runs print the same text", runReport(), report);
ok("the report states the counted set", report.indexOf("Records counted by the published rule: " + live.total) !== -1);
ok("the report prints no NaN or undefined", !/NaN|undefined/.test(report));
const REPORT_LINES = [
  ...E.PROVENANCE_VERDICTS.map((verdict) => [E.verdictDefinition(verdict).label, live.verdicts[verdict]]),
  ["Qualifying sources", live.qualifying_source_count],
  ["Qualifying sources annotated", live.annotated_qualifying_count],
  ["Sources pending annotation", live.pending_source_count],
  ["Qualifying sources with no publisher", live.missing_publisher_count]
];
REPORT_LINES.forEach(([label, value]) => {
  const printed = "  " + label.padEnd(40) + ": " + value + "\n";
  ok('the report line "' + label + '" carries the evidence.js figure', report.indexOf(printed) !== -1);
});

/* Backlog order, on a file built so that each sort key decides one pair. */
const backlogRecord = (id, status, sources) => ({
  id,
  title: id,
  verification_status: status,
  evidence_grade: "PRIMARY",
  sources
});
const one = (n) => source("s" + n, "Publisher " + n, "https://p" + n + ".example/x", "PRIMARY", null);
const backlogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "provenance-")), "incidents.json");
fs.writeFileSync(
  backlogFile,
  JSON.stringify({
    incidents: [
      backlogRecord("uncounted-with-three", "REPORTED", [one(1), one(2), one(3)]),
      backlogRecord("counted-b-with-one", "VERIFIED", [one(4)]),
      backlogRecord("counted-a-with-one", "VERIFIED", [one(5)]),
      backlogRecord("counted-with-two", "VERIFIED", [one(6), one(7)])
    ]
  })
);
check(
  "the backlog lists counted records first, then most qualifying sources, then id",
  (runReport([backlogFile]).match(/\[[a-z-]+\]/g) || []).join(" "),
  "[counted-with-two] [counted-a-with-one] [counted-b-with-one] [uncounted-with-three]"
);
fs.rmSync(path.dirname(backlogFile), { recursive: true });

/* ---------------------------------------------------- validator, by mutation */

console.log("\nValidator: one mutation per rule");
const VALID = () => [
  source("advisory", "Example Vendor", "https://vendor.example/advisory/1", "PRIMARY", ORIGINAL()),
  source("wire", "Example Wire", "https://wire.example/a", SECONDARY, derived(["advisory"], [])),
  source("daily", "Example Daily", "https://daily.example/b", SECONDARY, derived([], ["cve:cve-2026-0001"])),
  source("mirror", "Example Mirror", "https://mirror.example/c", "ROUNDUP", UNKNOWN())
];
const problemsAfter = (mutate) => {
  const sources = VALID();
  mutate(sources);
  return validate(asDataset(sources)).problems;
};
check("the annotated fixture is valid before mutation", problemsAfter(() => {}), []);
check(
  "sources with no provenance and no id are not checked at all",
  problemsAfter((s) =>
    s.forEach((x) => {
      delete x.id;
      delete x.provenance;
    })
  ),
  []
);

const provenanceOf = (sources, id) => sources.find((x) => x.id === id).provenance;
const MUTATIONS = [
  ["malformed source id", /lowercase slug/, (s) => (s[3].id = "Not A Slug")],
  ["duplicate source id", /duplicate source id/, (s) => (s[3].id = "wire")],
  ["provenance declared without an id", /id is required on a source that declares provenance/, (s) => delete s[3].id],
  ["provenance that is not an object", /provenance must be an object/, (s) => (s[3].provenance = "ORIGINAL")],
  ["unknown kind", /kind has unknown value "original"/, (s) => (provenanceOf(s, "advisory").kind = "original")],
  [
    "derives_from_internal not an array",
    /derives_from_internal must be an array of strings/,
    (s) => (provenanceOf(s, "wire").derives_from_internal = "advisory")
  ],
  [
    "derives_from_external holding a non-string",
    /derives_from_external must be an array of strings/,
    (s) => (provenanceOf(s, "daily").derives_from_external = [2026])
  ],
  ["note that is not a string", /note must be a string/, (s) => (provenanceOf(s, "advisory").note = 7)],
  [
    "ORIGINAL that lists a derivation",
    /is ORIGINAL and must not list/,
    (s) => (provenanceOf(s, "advisory").derives_from_internal = ["wire"])
  ],
  [
    "UNKNOWN that lists a derivation",
    /is UNKNOWN and must not list/,
    (s) => (provenanceOf(s, "mirror").derives_from_external = ["cve:cve-2026-0001"])
  ],
  [
    "DERIVED with no reference",
    /is DERIVED and must name at least one/,
    (s) => (provenanceOf(s, "wire").derives_from_internal = [])
  ],
  [
    "internal reference to a missing source",
    /names "nowhere", which is not a source id/,
    (s) => (provenanceOf(s, "wire").derives_from_internal = ["nowhere"])
  ],
  [
    "self-reference",
    /must not reference the source itself/,
    (s) => (provenanceOf(s, "wire").derives_from_internal = ["wire"])
  ],
  [
    "external key with an unlisted prefix",
    /key "blog:some-post" must look like/,
    (s) => (provenanceOf(s, "daily").derives_from_external = ["blog:some-post"])
  ],
  [
    "external key with no prefix",
    /must look like <prefix>:<slug>/,
    (s) => (provenanceOf(s, "daily").derives_from_external = ["something-without-a-prefix"])
  ],
  [
    "derivation cycle",
    /derivation cycle; sources on it or cited from it: advisory, daily, mirror, wire/,
    (s) => {
      s[0].provenance = derived(["daily"], []);
      s[1].provenance = derived(["advisory", "mirror"], []);
      s[2].provenance = derived(["wire"], []);
    }
  ]
];
MUTATIONS.forEach(([name, pattern, mutate]) => {
  const problems = problemsAfter(mutate);
  ok(name + " fails validation", problems.some((p) => pattern.test(p)));
});
check(
  "a non-string id on an annotated source is reported once",
  problemsAfter((s) => (s[3].id = 7)).length,
  1
);

console.log("\nValidator: evidence for every claim");
const P = require(path.join(__dirname, "validate-provenance.js"));
const annotated = () => withEvidence(VALID());
const evidenceOf = (sources, id) => provenanceOf(sources, id).evidence;
const problemsAfterEvidence = (mutate) => {
  const sources = annotated();
  mutate(sources);
  return validate(asRawDataset(sources)).problems;
};
check("the annotated fixture with evidence is valid", problemsAfterEvidence(() => {}), []);
const EVIDENCE_MUTATIONS = [
  [
    "ORIGINAL with no evidence",
    /evidence must list a quote and an archived snapshot/,
    (s) => delete provenanceOf(s, "advisory").evidence
  ],
  [
    "ORIGINAL with an empty evidence list",
    /evidence must list a quote/,
    (s) => (provenanceOf(s, "advisory").evidence = [])
  ],
  [
    "ORIGINAL without a basis",
    /original_basis must be one of/,
    (s) => delete provenanceOf(s, "advisory").original_basis
  ],
  [
    "ORIGINAL with an unknown basis",
    /original_basis must be one of/,
    (s) => (provenanceOf(s, "advisory").original_basis = "HUNCH")
  ],
  [
    "a basis on a DERIVED source",
    /original_basis is only for ORIGINAL/,
    (s) => (provenanceOf(s, "wire").original_basis = "OWN_RESEARCH")
  ],
  [
    "a DERIVED reference with no evidence entry",
    /has no entry supporting "cve:cve-2026-0001"/,
    (s) => (evidenceOf(s, "daily")[0].supports = "advisory")
  ],
  [
    "evidence for something the source does not claim",
    /"advisory" is not a claim of this source/,
    (s) => (evidenceOf(s, "daily")[0].supports = "advisory")
  ],
  [
    "a quote that is too short",
    /quote must be 20-300 characters/,
    (s) => (evidenceOf(s, "advisory")[0].quote = "too short")
  ],
  [
    "a quote that is too long",
    /quote must be 20-300 characters/,
    (s) => (evidenceOf(s, "advisory")[0].quote = "x".repeat(301))
  ],
  [
    "a snapshot that is not on the Wayback Machine",
    /snapshot_url must be a https:\/\/web\.archive\.org/,
    (s) => (evidenceOf(s, "advisory")[0].snapshot_url = "https://example.com/copy")
  ],
  [
    "a snapshot of another page",
    /capture of this source's own url/,
    (s) => (evidenceOf(s, "advisory")[0].snapshot_url = snapshotOf("https://elsewhere.example/page"))
  ],
  [
    "an unknown field in provenance",
    /unknown field "account"/,
    (s) => (provenanceOf(s, "advisory").account = "github:alice")
  ],
  ["an unknown field in an evidence entry", /unknown field "page"/, (s) => (evidenceOf(s, "advisory")[0].page = 4)],
  [
    "evidence on an UNKNOWN source",
    /evidence is only for ORIGINAL and DERIVED/,
    (s) => (provenanceOf(s, "mirror").evidence = [])
  ],
  [
    "an outside origin that is not registered",
    /"vendor:made-up-advisory" is not registered/,
    (s) => {
      provenanceOf(s, "daily").derives_from_external = ["vendor:made-up-advisory"];
      evidenceOf(s, "daily")[0].supports = "vendor:made-up-advisory";
    }
  ],
  [
    "a cve key that is not a CVE id",
    /cve key like cve:cve-2024-0001/,
    (s) => {
      provenanceOf(s, "daily").derives_from_external = ["cve:2026-1"];
      evidenceOf(s, "daily")[0].supports = "cve:2026-1";
    }
  ]
];
EVIDENCE_MUTATIONS.forEach(([name, pattern, mutate]) => {
  ok(name + " fails validation", problemsAfterEvidence(mutate).some((p) => pattern.test(p)));
});
check(
  "a snapshot stored with http, www and a trailing slash still matches its source",
  problemsAfterEvidence((s) => {
    evidenceOf(s, "advisory")[0].snapshot_url = snapshotOf("http://www.vendor.example/advisory/1/");
  }),
  []
);
check(
  "registered keys match without regard to case",
  problemsAfterEvidence((s) => {
    provenanceOf(s, "daily").derives_from_external = ["cve:CVE-2026-0001"];
    evidenceOf(s, "daily")[0].supports = "cve:CVE-2026-0001";
  }),
  []
);

console.log("\nValidator: the outside-origin registry");
const registryWith = (roots) => ({ roots });
const origin = (key) => ({ title: "Origin " + key, url: "https://origin.example/" + key });
const publishedRegistry = require(path.join(__dirname, "..", "data", "external-roots.json"));
check("the published registry is well formed", P.checkRegistry(publishedRegistry), {
  problems: [],
  warnings: []
});
const REGISTRY_MUTATIONS = [
  ["a registry that is not an object of roots", { entries: [] }, /must be an object with a "roots" object/],
  ["an uppercase key", registryWith({ "CVE:CVE-2026-0001": origin("x") }), /must be lowercase/],
  ["a malformed cve key", registryWith({ "cve:2026-1": origin("x") }), /cve key like/],
  ["an entry without a title", registryWith({ "vendor:acme": { url: "https://acme.example" } }), /needs a title/],
  ["an entry without a url", registryWith({ "vendor:acme": { title: "Acme advisory" } }), /needs an http or https url/]
];
REGISTRY_MUTATIONS.forEach(([name, registry, pattern]) => {
  ok(name + " fails", P.checkRegistry(registry).problems.some((p) => pattern.test(p)));
});
check(
  "two keys that differ only by leading zeros are flagged as a likely duplicate",
  P.checkRegistry(registryWith({ "cve:cve-2026-0001": origin("a"), "cve:cve-2026-00001": origin("b") })).warnings
    .length,
  1
);
const unusedRegistry = { roots: { ...TEST_REGISTRY.roots, "vendor:never-cited": origin("never") } };
ok(
  "a registered key nothing cites is reported as a warning",
  V.validateDataset(asDataset(VALID()), { registry: unusedRegistry }).warnings.some((w) =>
    /"vendor:never-cited" is not used/.test(w)
  )
);

console.log("\n" + "-".repeat(64));
if (failures.length) {
  console.log("FAILED: " + failures.length + " assertion(s) failed, " + passed + " passed.");
  process.exit(1);
}
console.log("PASSED: " + passed + " assertions.");
