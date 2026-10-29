/*
 * Counter tests for the AI Consequence Clock preview.
 *
 *   node tests/derive.test.js
 *
 * These tests recompute every published total directly from data/incidents.json
 * using independent arithmetic, then assert that js/evidence.js agrees. Because
 * js/clock.js renders nothing it has not received from evidence.js, a passing
 * run means the page cannot be showing a number the data does not support.
 *
 * No dependencies, no test framework, no build step.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "js", "evidence.js"));

const DATA_PATH = path.join(__dirname, "..", "data", "incidents.json");
const dataset = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const FIXED_TODAY = "2026-09-28";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
    console.log("  ok   " + name);
  } else {
    failures.push({ name, actual: a, expected: b });
    console.log("  FAIL " + name + "\n         expected " + b + "\n         actual   " + a);
  }
}

function ok(name, condition, detail) {
  check(name + (detail ? " — " + detail : ""), !!condition, true);
}

/* Independent recomputation, deliberately not reusing evidence.js internals. */
function expectedHeadline(records) {
  return records.filter(
    (r) =>
      ["VERIFIED", "CORROBORATED"].includes(r.verification_status) &&
      ["PRIMARY", "INDEPENDENT_SECONDARY"].includes(r.evidence_grade)
  );
}

const records = dataset.incidents;
const summary = E.derive(dataset, FIXED_TODAY);
const headline = expectedHeadline(records);

console.log("\nDataset: " + records.length + " records, " + headline.length + " headline-eligible\n");

console.log("Headline rule");
check("headline count matches an independent filter", summary.headline_count, headline.length);
check("excluded count is the remainder", summary.excluded_count, records.length - headline.length);
check("record count matches the file", summary.record_count, records.length);
check(
  "headline ids match",
  summary.headline_ids.slice().sort(),
  headline.map((r) => r.id).sort()
);
ok("at least one record is headline-eligible", summary.headline_count > 0);
ok(
  "headline set is a strict subset when anything is excluded",
  summary.headline_count <= summary.record_count
);

console.log("\nEvery excluded record names a reason");
records.forEach((r) => {
  const ex = E.exclusion(r);
  const eligible = E.isHeadlineEligible(r);
  if (eligible) {
    check("no exclusion on eligible record " + r.id, ex, null);
  } else {
    ok(
      "exclusion reason present for " + r.id,
      ex && ["status", "grade", "status_and_grade"].includes(ex.code) && ex.detail.length > 20
    );
    // The named reason must match the actual field that failed.
    const statusFails = !["VERIFIED", "CORROBORATED"].includes(r.verification_status);
    const gradeFails = !["PRIMARY", "INDEPENDENT_SECONDARY"].includes(r.evidence_grade);
    check("reason is accurate for " + r.id, [ex.status_fails, ex.grade_fails], [statusFails, gradeFails]);
  }
});

/*
 * The reason printed on the card must describe the state the record is in. Only REPORTED
 * means "one source, not yet corroborated"; saying that about a retracted record would
 * publish a false reason.
 */
console.log("\nStatus-only exclusions name the actual review state");
const qualifying = records.find((r) => E.isHeadlineEligible(r));
const reportedDetail = E.exclusion({ ...qualifying, verification_status: "REPORTED" }).detail;
ok("REPORTED keeps the single-source sentence", /single qualifying source/i.test(reportedDetail));
["UNDER_REVIEW", "DISPUTED", "RETRACTED"].forEach((status) => {
  const ex = E.exclusion({ ...qualifying, verification_status: status });
  check(status + " is excluded on review state alone", ex.code, "status");
  ok(status + " does not claim a single qualifying source", !/single qualifying source/i.test(ex.detail));
  ok(status + " detail names the state", ex.detail.indexOf(status) !== -1);
});

console.log("\nOccurrence split never inflates the incident count");
const expectedDocumented = headline.filter((r) => r.adversary !== "research_demo").length;
const expectedDemonstrated = headline.filter((r) => r.adversary === "research_demo").length;
check("documented occurrences", summary.documented_occurrences, expectedDocumented);
check("demonstrated capabilities", summary.demonstrated_capabilities, expectedDemonstrated);
check(
  "split sums to the headline set and nothing more",
  summary.documented_occurrences + summary.demonstrated_capabilities,
  summary.headline_count
);

console.log("\nMetrics that must stay separate");
// causal_role on a vulnerability record describes what the flaw would let an agent do,
// not something an agent did. The count is restricted to documented occurrences so a
// capability is never reported as an event.
check(
  "agent-caused reads causal_role and counts documented occurrences only",
  summary.agent_caused,
  headline.filter(
    (r) =>
      ["agent_initiated", "agent_executed"].includes(r.causal_role) &&
      r.adversary !== "research_demo"
  ).length
);
check(
  "agent-caused never counts a demonstrated capability",
  headline.filter(
    (r) =>
      ["agent_initiated", "agent_executed"].includes(r.causal_role) &&
      r.adversary === "research_demo"
  ).length > 0
    ? summary.agent_caused <
      headline.filter((r) => ["agent_initiated", "agent_executed"].includes(r.causal_role)).length
    : true,
  true
);
check(
  "unauthorized actions counts explicit true only",
  summary.unauthorized_actions,
  headline.filter((r) => r.unauthorized_claim === "true").length
);
check(
  "authorization gap counts none_documented only",
  summary.authorization_gap,
  headline.filter((r) => r.authorization_evidence === "none_documented").length
);
// The two must not be ORed together, which is the specific error the
// methodology direction document forbids.
const ored = headline.filter(
  (r) => r.unauthorized_claim === "true" || r.authorization_evidence === "none_documented"
).length;
ok(
  "unauthorized and authorization-gap are not ORed",
  summary.unauthorized_actions <= ored && summary.authorization_gap <= ored,
  "neither equals the union unless the sets genuinely coincide"
);
records.forEach((r) => {
  ok(
    "agent-caused is not inferred from text for " + r.id,
    !(
      /agent|autonomous/i.test(r.title + " " + r.summary) &&
      !["agent_initiated", "agent_executed"].includes(r.causal_role) &&
      E.isAgentCaused(r)
    )
  );
});

console.log("\nMoney");
const expectedMoney = {};
headline.forEach((r) => {
  const row = r.financial_loss_confirmed;
  if (row && typeof row.amount === "number") {
    expectedMoney[row.currency] = (expectedMoney[row.currency] || 0) + row.amount;
  }
});
check(
  "confirmed money grouped by currency",
  Object.keys(summary.confirmed_money).reduce((acc, k) => {
    acc[k] = summary.confirmed_money[k].amount;
    return acc;
  }, {}),
  expectedMoney
);
ok(
  "no confirmed total is built from an estimate",
  records.every((r) => {
    const c = r.financial_loss_confirmed;
    const e = r.financial_loss_estimated;
    if (!c || !e) return true;
    return c.amount !== e.amount || c.currency !== e.currency;
  })
);
ok(
  "every confirmed amount sits on a record with at least one source",
  records.every((r) => !r.financial_loss_confirmed || (r.sources || []).length > 0)
);

/*
 * Read from E.AXES rather than a hardcoded list, so adding an axis cannot add an untested
 * view. The year axis was added with the list hardcoded and the assertion count did not
 * move, which is how a new published breakdown slipped past the suite once already.
 */
const AXIS_NAMES = Object.keys(E.AXES);

console.log("\nAxes: " + AXIS_NAMES.join(", "));
AXIS_NAMES.forEach((axisName) => {
  const axis = E.AXES[axisName];
  // An axis either reads a field or derives its value. Both must round-trip to a record.
  const valueOf = axis.value ? axis.value : (r) => r[axis.key];
  const groups = summary.axes[axisName];

  const headlineSum = groups.reduce((a, g) => a + g.headline, 0);
  const excludedSum = groups.reduce((a, g) => a + g.excluded, 0);
  const totalSum = groups.reduce((a, g) => a + g.total, 0);

  check(axisName + ": headline counts sum to the headline set", headlineSum, headline.length);
  check(axisName + ": excluded counts sum to the remainder", excludedSum, records.length - headline.length);
  check(axisName + ": every record is grouped exactly once", totalSum, records.length);

  groups.forEach((g) => {
    check(
      axisName + " / " + g.label + ": headline plus excluded equals total",
      g.headline + g.excluded,
      g.total
    );
    check(
      axisName + " / " + g.label + ": exclusion reasons sum to excluded",
      g.exclusions.status + g.exclusions.grade + g.exclusions.status_and_grade,
      g.excluded
    );
    check(
      axisName + " / " + g.label + ": id lists match the counts",
      [g.headline_ids.length, g.excluded_ids.length],
      [g.headline, g.excluded]
    );
    // Every value shown must exist verbatim on a record.
    if (g.supported) {
      ok(
        axisName + " / " + g.label + ": value exists on a record",
        records.some((r) => String(valueOf(r)) === String(g.value))
      );
    }
  });
});

const yearLabels = summary.axes.year.filter((g) => g.supported).map((g) => g.value);
ok(
  "year axis stays in chronological order",
  yearLabels.every((label, i) => i === 0 || yearLabels[i - 1] <= label)
);

console.log("\nGeography is never inferred");
const unsupportedGroup = summary.axes.country.find((g) => !g.supported);
const expectedUnsupported = records.filter(
  (r) => !r.country_region || r.country_region === "Unknown" || r.country_region === "unknown"
).length;
check("records with no established region", summary.geography_unsupported, expectedUnsupported);
if (expectedUnsupported > 0) {
  ok("unsupported geography is its own group", !!unsupportedGroup);
  check("unsupported group holds exactly those records", unsupportedGroup.total, expectedUnsupported);
  ok(
    "unsupported group is not labelled as a country",
    unsupportedGroup.label === "Not established by sources"
  );
  ok("unsupported group sorts last", summary.axes.country[summary.axes.country.length - 1] === unsupportedGroup);
}
summary.axes.country.forEach((g) => {
  ok(
    "country group " + g.label + " is not the string Unknown",
    g.label !== "Unknown" && g.label !== "unknown"
  );
});

console.log("\nDay counter moves with the calendar");
const since = E.daysSinceLatestDisclosure(records, FIXED_TODAY);
const later = E.daysSinceLatestDisclosure(records, "2026-10-28");
ok("day counter is a number", typeof since.days === "number");
check("day counter advances by 30 when today advances 30 days", later.days - since.days, 30);
ok("day counter is never negative", since.days >= 0);

console.log("\nDisclosure lag");
const lagValues = headline
  .map((r) =>
    typeof r.disclosure_lag_days === "number"
      ? r.disclosure_lag_days
      : E.daysBetween(r.incident_date, r.disclosure_date)
  )
  .filter((d) => d !== null && d >= 0);
check("lag sample size", summary.disclosure_lag_n, lagValues.length);
check(
  "lag average",
  summary.disclosure_lag_average,
  lagValues.length ? Math.round(lagValues.reduce((a, b) => a + b, 0) / lagValues.length) : null
);
records.forEach((r) => {
  if (typeof r.disclosure_lag_days === "number" && r.incident_date && r.disclosure_date) {
    check(
      "stored lag matches the dates for " + r.id,
      r.disclosure_lag_days,
      E.daysBetween(r.incident_date, r.disclosure_date)
    );
  }
});

console.log("\nRecord integrity");
const REQUIRED = [
  "id",
  "title",
  "summary",
  "verification_status",
  "evidence_grade",
  "category",
  "causal_role",
  "adversary",
  "authorization_evidence",
  "unauthorized_claim",
  "reversibility",
  "consequence_class",
  "sector",
  "sources"
];
records.forEach((r) => {
  REQUIRED.forEach((f) => {
    ok("record " + r.id + " has " + f, r[f] !== undefined && r[f] !== null && r[f] !== "");
  });
  ok("record " + r.id + " has at least one source", Array.isArray(r.sources) && r.sources.length > 0);
  ok(
    "record " + r.id + " sources are http(s) only",
    r.sources.every((s) => /^https?:\/\//i.test(s.url || ""))
  );
  ok(
    "record " + r.id + " has a vulnerability definition or is flagged",
    E.vulnerabilityDefinition(r.category) !== undefined
  );
});
check("ids are unique", new Set(records.map((r) => r.id)).size, records.length);

console.log("\nEvery upgraded record carries a revision and a change log");
records.forEach((r) => {
  if (r.revision && r.revision > 1) {
    ok(
      "record " + r.id + " revision " + r.revision + " has a change log",
      Array.isArray(r.change_log) && r.change_log.length > 0
    );
    ok(
      "record " + r.id + " change log names the current revision",
      r.change_log.some((c) => c.revision === r.revision)
    );
  }
  // A headline-eligible record must have a qualifying source actually attached.
  if (E.isHeadlineEligible(r)) {
    ok(
      "headline record " + r.id + " has a PRIMARY or INDEPENDENT_SECONDARY source attached",
      r.sources.some((s) => ["PRIMARY", "INDEPENDENT_SECONDARY"].includes(s.evidence_grade))
    );
  }
});

/*
 * Pinned baseline.
 *
 * Every assertion above recomputes its expectation from the same file it is
 * checking, so deleting a record moves both sides together and passes. That is
 * the one failure mode this project cannot tolerate: a record silently leaving
 * the dataset would take its counter down with it and look correct.
 *
 * tests/expected.json is the committed answer key. A change to any published
 * total must be deliberate, must ship in the same commit as the data change,
 * and must carry its reason in that record's change_log.
 */
console.log("\nPinned baseline (tests/expected.json)");
const EXPECTED_PATH = path.join(__dirname, "expected.json");
const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, "utf8"));

check("pinned record count", summary.record_count, expected.record_count);
check("pinned headline count", summary.headline_count, expected.headline_count);
check("pinned headline ids", summary.headline_ids.slice().sort(), expected.headline_ids);
check("pinned documented occurrences", summary.documented_occurrences, expected.documented_occurrences);
check("pinned demonstrated capabilities", summary.demonstrated_capabilities, expected.demonstrated_capabilities);
check("pinned agent-caused", summary.agent_caused, expected.agent_caused);
check("pinned unauthorized actions", summary.unauthorized_actions, expected.unauthorized_actions);
check("pinned authorization gap", summary.authorization_gap, expected.authorization_gap);
check(
  "pinned confirmed money",
  Object.keys(summary.confirmed_money).reduce((acc, k) => {
    acc[k] = summary.confirmed_money[k].amount;
    return acc;
  }, {}),
  expected.confirmed_money
);
check("pinned geography not established", summary.geography_unsupported, expected.geography_not_established);
check("pinned disclosure lag average", summary.disclosure_lag_average, expected.disclosure_lag_average);
check("pinned disclosure lag sample", summary.disclosure_lag_n, expected.disclosure_lag_n);

AXIS_NAMES.forEach((axisName) => {
  const live = summary.axes[axisName].reduce((acc, g) => {
    acc[g.label] = { headline: g.headline, excluded: g.excluded };
    return acc;
  }, {});
  check("pinned " + axisName + " breakdown", live, expected.axes[axisName]);
});

/*
 * Also verify the published summary.json has not drifted from the records. It is
 * a build artifact and a stale one would mislead anyone reading it directly.
 */
console.log("\nPublished summary.json agrees with the records");
const publishedPath = path.join(__dirname, "..", "data", "summary.json");
if (fs.existsSync(publishedPath)) {
  const published = JSON.parse(fs.readFileSync(publishedPath, "utf8"));
  const digest = require("crypto")
    .createHash("sha256")
    .update(records.map((r) => r.id).sort().join(","))
    .digest("hex");
  check("summary.json record count", published.record_count, summary.record_count);
  check("summary.json eligible count", published.eligible_record_count, summary.headline_count);
  check("summary.json hero count", published.hero_count, summary.authorization_gap);
  check("summary.json checksum", published.dataset_checksum_sha256, digest);
  const { contentDigest } = require(path.join(__dirname, "..", "scripts", "content-digest.js"));
  const content = contentDigest(records);
  check("summary.json content checksum", published.dataset_content_sha256, content);
  check("summary.json headline rule is unchanged", published.headline_rule, dataset.headline_rule);
  const provenance = E.comparePublishedSummary(summary, published, digest);
  check("footer provenance reports a full summary match", provenance.status, "matches");
  const noSummary = E.comparePublishedSummary(summary, null, digest);
  check("footer provenance distinguishes a failed summary fetch", noSummary.status, "unavailable");
  const noCrypto = E.comparePublishedSummary(summary, published, "unavailable in this context");
  check("footer provenance distinguishes unavailable crypto", noCrypto.status, "matches_without_checksum");
  const both = E.comparePublishedSummary(summary, published, { idDigest: digest, contentDigest: content });
  check("footer provenance matches with both checksums", both.status, "matches");

  /*
   * An edit to a record's text keeps the same ids, so the id checksum cannot see it. The
   * content checksum must, and must say which published field disagrees.
   */
  const retitled = records.map((r, i) => (i === 0 ? { ...r, title: r.title + " (edited)" } : r));
  const retitledIds = require("crypto")
    .createHash("sha256")
    .update(retitled.map((r) => r.id).sort().join(","))
    .digest("hex");
  check("an edited title leaves the id checksum unchanged", retitledIds, digest);
  ok("an edited title changes the content checksum", contentDigest(retitled) !== content);
  const edited = E.comparePublishedSummary(summary, published, {
    idDigest: retitledIds,
    contentDigest: contentDigest(retitled)
  });
  check("footer provenance reports the edited content", [edited.status, edited.mismatches], [
    "differs",
    ["dataset_content_sha256"]
  ]);
  ok(
    "the content checksum does not depend on key order inside a record",
    contentDigest(records.map((r) => Object.fromEntries(Object.entries(r).reverse()))) === content
  );

  if (headline.length > 0) {
    const victim = headline[0].id;
    const downgraded = {
      ...dataset,
      incidents: records.map((r) => (r.id === victim ? { ...r, evidence_grade: "ROUNDUP" } : r))
    };
    const afterDowngrade = E.derive(downgraded, FIXED_TODAY);
    const degradedProvenance = E.comparePublishedSummary(afterDowngrade, published, digest);
    check("footer provenance detects moved headline totals with the same id checksum", degradedProvenance.status, "differs");
    ok(
      "footer provenance names the changed headline count",
      degradedProvenance.mismatches.indexOf("eligible_record_count") !== -1
    );
  }
} else {
  ok("summary.json exists", false, "data/summary.json is missing");
}

/*
 * Regression guard. Removing a headline record must change the totals. If this
 * assertion ever passes silently, the counters have stopped tracking the file.
 */
console.log("\nRegression guard: mutating the data must move the counters");
if (headline.length > 0) {
  const victim = headline[0].id;
  const mutated = {
    ...dataset,
    incidents: records.filter((r) => r.id !== victim)
  };
  const after = E.derive(mutated, FIXED_TODAY);
  ok("removing a headline record lowers the headline count", after.headline_count === summary.headline_count - 1);
  ok("removing a headline record lowers the record count", after.record_count === summary.record_count - 1);
  ok(
    "removing a headline record removes it from every axis",
    AXIS_NAMES.every(
      (ax) => after.axes[ax].reduce((a, g) => a + g.total, 0) === summary.record_count - 1
    )
  );

  const downgraded = {
    ...dataset,
    incidents: records.map((r) => (r.id === victim ? { ...r, evidence_grade: "ROUNDUP" } : r))
  };
  const afterDowngrade = E.derive(downgraded, FIXED_TODAY);
  ok(
    "downgrading evidence removes a record from headline totals but not from the feed",
    afterDowngrade.headline_count === summary.headline_count - 1 &&
      afterDowngrade.record_count === summary.record_count
  );

  const fakeMoney = {
    ...dataset,
    incidents: records.map((r) =>
      r.id === victim
        ? { ...r, financial_loss_confirmed: null, financial_loss_estimated: { amount: 9e9, currency: "USD" } }
        : r
    )
  };
  const afterFake = E.derive(fakeMoney, FIXED_TODAY);
  ok(
    "an estimate never enters the confirmed-money total",
    !Object.keys(afterFake.confirmed_money).some((c) => afterFake.confirmed_money[c].amount >= 9e9)
  );
}

/*
 * Feed filters. A filter narrows the list a visitor reads and nothing else, so each
 * criterion is checked against its own recomputation and the totals are checked to be
 * exactly what they were before any filter ran.
 */
console.log("\nFeed filters narrow the list and never the totals");
const ids = (list) => list.map((r) => r.id).sort();

check("no criteria returns every record", ids(E.filterRecords(records)), ids(records));
check("empty criteria returns every record", ids(E.filterRecords(records, {})), ids(records));

// Each select narrows on exactly one field, for every value present in the data.
const FILTER_FIELDS = {
  status: "verification_status",
  grade: "evidence_grade",
  category: "category",
  sector: "sector"
};
Object.keys(FILTER_FIELDS).forEach((name) => {
  const field = FILTER_FIELDS[name];
  Array.from(new Set(records.map((r) => r[field]))).forEach((value) => {
    check(
      "filter " + name + " = " + value,
      ids(E.filterRecords(records, { [name]: value })),
      ids(records.filter((r) => r[field] === value))
    );
  });
});

check("inHeadline headline is the headline set", ids(E.filterRecords(records, { inHeadline: "headline" })), ids(headline));
check(
  "inHeadline excluded is the remainder",
  ids(E.filterRecords(records, { inHeadline: "excluded" })),
  ids(records.filter((r) => !headline.includes(r)))
);
check("inHeadline all returns every record", ids(E.filterRecords(records, { inHeadline: "all" })), ids(records));

// Text search reads title, organization and summary, ignoring case. Literals are taken
// from the current records: one term per field, so each field is shown to be searched.
check("text matches a title", ids(E.filterRecords(records, { text: "BEREAVEMENT" })), ["acc-2024-02-14-air-canada"]);
check("text matches an organization", ids(E.filterRecords(records, { text: "legit security" })), ["acc-2025-06-camoleak"]);
check("text matches a summary", ids(E.filterRecords(records, { text: "Tribunal" })), ["acc-2024-02-14-air-canada"]);
check(
  "text search ignores case and surrounding space",
  ids(E.filterRecords(records, { text: "  PROMPT injection " })),
  ids(E.filterRecords(records, { text: "prompt injection" }))
);
check(
  "text search agrees with an independent substring match",
  ids(E.filterRecords(records, { text: "database" })),
  ids(records.filter((r) => [r.title, r.organization, r.summary].join("\n").toLowerCase().includes("database")))
);
check("blank text matches every record", ids(E.filterRecords(records, { text: "   " })), ids(records));

const combined = { status: "VERIFIED", sector: "software", inHeadline: "headline", text: "prompt injection" };
check(
  "criteria AND together",
  ids(E.filterRecords(records, combined)),
  ids(
    headline.filter(
      (r) =>
        r.verification_status === "VERIFIED" &&
        r.sector === "software" &&
        [r.title, r.organization, r.summary].join("\n").toLowerCase().includes("prompt injection")
    )
  )
);
ok("the combined example is not trivially empty", E.filterRecords(records, combined).length > 0);

// A value no record carries, including a wrong-case one, matches nothing rather than
// being ignored. Field values are case-sensitive throughout this project.
["status", "grade", "category", "sector"].forEach((name) => {
  check("unknown " + name + " matches nothing", E.filterRecords(records, { [name]: "no-such-value" }).length, 0);
});
check("lowercase status matches nothing", E.filterRecords(records, { status: "verified" }).length, 0);
check("unknown inHeadline matches nothing", E.filterRecords(records, { inHeadline: "maybe" }).length, 0);
check("unmatched text matches nothing", E.filterRecords(records, { text: "zz-no-record-says-this" }).length, 0);

// Each select offers exactly the values present in the data, so no option is empty.
const options = E.filterOptions(records);
check("filter options cover the four selects", Object.keys(options).sort(), Object.keys(FILTER_FIELDS).sort());
Object.keys(FILTER_FIELDS).forEach((name) => {
  const field = FILTER_FIELDS[name];
  check(
    "options for " + name + " are the distinct values present",
    options[name],
    Array.from(new Set(records.map((r) => r[field]).filter(Boolean))).sort()
  );
  ok(
    "every " + name + " option matches at least one record",
    options[name].every((value) => E.filterRecords(records, { [name]: value }).length > 0)
  );
});

const before = JSON.stringify(E.derive(dataset, FIXED_TODAY));
const recordsBefore = JSON.stringify(records);
[{}, { inHeadline: "excluded" }, combined, { sector: "no-such-value" }].forEach((criteria) => {
  const narrowed = E.filterRecords(records, criteria);
  narrowed.length = 0;
  check(
    "filtering by " + JSON.stringify(criteria) + " leaves derive() unchanged",
    JSON.stringify(E.derive(dataset, FIXED_TODAY)) === before,
    true
  );
});
check("filtering never mutates the records", JSON.stringify(records) === recordsBefore, true);

console.log("\n" + "-".repeat(64));
if (failures.length) {
  console.log("FAILED: " + failures.length + " assertion(s) failed, " + passed + " passed.");
  process.exit(1);
}
console.log("PASSED: " + passed + " assertions.");
