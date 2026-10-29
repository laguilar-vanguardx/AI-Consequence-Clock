/*
 * Offline tests for scripts/verify-provenance-quotes.js.
 *
 *   node tests/verify-provenance-quotes.test.js
 *
 * The network is replaced by a fake fetch and the waits by a no-op, so every outcome,
 * including rate limits and outages, is reproducible.
 */
"use strict";

const path = require("path");
const Q = require(path.join(__dirname, "..", "scripts", "verify-provenance-quotes.js"));

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

const SNAPSHOT = "https://web.archive.org/web/20260101000000/https://tribunal.example/decision/1";
const PAGE =
  "<html><head><style>.x{}</style><script>var hidden = 'The tribunal found';</script></head><body>" +
  "<p>The tribunal found that the airline&#8217;s chatbot&nbsp;was\n   part of its website &mdash; " +
  "and the airline is responsible.</p></body></html>";
const entry = (quote) => ({ record: "r1", source: "s1", supports: "original", quote, snapshot_url: SNAPSHOT });

/* A fetch that replays the given responses in order; an Error is thrown, anything else returned. */
function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchText: (url) => {
      calls.push(url);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
  };
}
const noWait = () => Promise.resolve();
const run = async (quote, responses, cache) => {
  const fake = fakeFetch(responses);
  const out = await Q.checkEntries([entry(quote)], { fetchText: fake.fetchText, sleep: noWait, cache });
  return { result: out.results[0], cache: out.cache, calls: fake.calls };
};

async function main() {
  console.log("Matching");
  const ok200 = [{ status: 200, body: PAGE }];
  check("a quote on the page is found", (await run("chatbot was part of its website", ok200)).result.state, Q.FOUND);
  check(
    "curly quotes, entities, dashes and line breaks do not matter",
    (await run("the airline's chatbot was part of its website - and the airline is responsible", ok200)).result.state,
    Q.FOUND
  );
  const absent = await run("the airline is not responsible", ok200);
  check("a quote that is not on the page is not found", absent.result.state, Q.NOT_FOUND);
  const credited = [
    { status: 200, body: "<p>According to <a href='/r'>Reuters</a>, the company&rsquo;s bot ( beta ) leaked data.</p>" }
  ];
  check(
    "named curly-quote entities and a link before punctuation do not matter",
    (await run("according to Reuters, the company's bot (beta) leaked data", credited)).result.state,
    Q.FOUND
  );
  check("text inside a script is not page text", (await run("var hidden", ok200)).result.state, Q.NOT_FOUND);
  check(
    "the raw capture is requested, without the archive toolbar",
    (await run("anything at all here", ok200)).calls[0],
    "https://web.archive.org/web/20260101000000id_/https://tribunal.example/decision/1"
  );

  console.log("\nFailures are never reported as absences");
  const limited = await run("chatbot was part of its website", [{ status: 429, body: "" }]);
  check(
    "a rate limit that never clears is a failed lookup",
    [limited.result.state, limited.result.reason],
    [Q.FAILED, "HTTP 429"]
  );
  check("a rate limit is retried before giving up", limited.calls.length, 4);
  const thrown = await run("chatbot was part of its website", [new Error("socket hang up")]);
  check(
    "a network error is a failed lookup",
    [thrown.result.state, thrown.result.reason],
    [Q.FAILED, "socket hang up"]
  );
  const recovered = await run("chatbot was part of its website", [
    { status: 503, body: "" },
    { status: 200, body: PAGE }
  ]);
  check("an outage that clears on retry still finds the quote", recovered.result.state, Q.FOUND);
  const missing = await run("chatbot was part of its website", [{ status: 404, body: "" }]);
  check(
    "a missing capture is a failed lookup, not retried",
    [missing.result.state, missing.calls.length],
    [Q.FAILED, 1]
  );

  console.log("\nCache");
  const first = await run("chatbot was part of its website", ok200, {});
  const again = await run("chatbot was part of its website", [new Error("must not be called")], first.cache);
  check(
    "a definite result is reused without a request",
    [again.result.state, again.result.cached, again.calls.length],
    [Q.FOUND, true, 0]
  );
  const failedRun = await run("chatbot was part of its website", [new Error("x")], {});
  check("a failed lookup is never cached", Object.keys(failedRun.cache).length, 0);

  console.log("\nSelecting what to check");
  const dataset = (quote) => ({
    incidents: [
      {
        id: "r1",
        sources: [
          { id: "s1", provenance: { evidence: [{ supports: "original", quote, snapshot_url: SNAPSHOT }] } },
          { id: "s2" }
        ]
      }
    ]
  });
  check("only evidence entries are collected", Q.collectEvidence(dataset("a quote")).length, 1);
  const evidenceOf = (quote) => Q.collectEvidence(dataset(quote));
  const unchanged = Q.changedSince(evidenceOf("same"), evidenceOf("same"));
  check("an unchanged quote is not rechecked on a pull request", unchanged.length, 0);
  check("a changed quote is rechecked", Q.changedSince(evidenceOf("new"), evidenceOf("old")).length, 1);

  console.log("\n" + "-".repeat(64));
  if (failures.length) {
    console.log("FAILED: " + failures.length + " assertion(s) failed, " + passed + " passed.");
    process.exit(1);
  }
  console.log("PASSED: " + passed + " assertions.");
}

main().catch((err) => {
  console.log("  FAIL test run threw: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
