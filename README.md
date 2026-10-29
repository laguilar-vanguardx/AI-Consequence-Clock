# AI Consequence Clock™

Open, auditable measurement of publicly verifiable AI consequences.

**Preview URL (intended):** https://aimodularity.com/ai-consequence-clock

This folder is a Milestone 0/1 starter: a public page, a methodology page, a sourced seed dataset, and an implementation proposal that answers section 15 of the development specification.

## License status

No open-source license has been granted yet. Apache-2.0 is listed in `IMPLEMENTATION_PROPOSAL.md` as pending counsel, not as the current license. Do not assume reuse rights until a `LICENSE` file is added.

## Trust model

**AI discovers. Evidence verifies. Sources remain visible.**

The preview does **not** claim complete global coverage. Every headline number is computed from `data/incidents.json`. The concept render in `assets/concept-render.png` is illustrative. Those multi-million counters are not wired into the page.

## Run locally

No build step.

```bash
cd ai-consequence-clock
python3 -m http.server 4173
```

Open http://localhost:4173

If you open `index.html` as a file:// URL, `fetch` of the JSON may be blocked by the browser. Use the local server. The page now says so on screen instead of failing silently.

## Verify the numbers

```bash
node tests/derive.test.js
node tests/validate-records.js
node tests/validate.test.js
node tests/sensitivity.test.js
node tests/methodology-render.test.js
node tests/provenance.test.js
node tests/source-graph.test.js
node tests/consumer-policy.test.js
node tests/provenance-history.test.js
node tests/verify-provenance-quotes.test.js
node tests/codeowners.test.js
```

`derive.test.js` recomputes every published total from `data/incidents.json` and compares them against the pinned baseline in `tests/expected.json`. No dependencies, no test framework. `validate.test.js` mutates a copy of the file: a lowercase `verified` status, a `javascript:` archive URL, a PRIMARY record with no named primary document, and the geography placeholder `Unknown` must each fail validation. The live file must not. The same file mutates pairs of fields that state one fact twice, such as `rolled_back` against `reversibility`, and each contradiction must fail.

`validate-records.js` checks every field on every record against the allowed vocabulary and shape before any arithmetic runs.

`sensitivity.test.js` checks the table on the methodology page that shows what the headline count would be under six rule sets, from strictest to no filter. The published row must select exactly what the published rule selects. `methodology-render.test.js` runs the script that draws that table against a stand-in DOM node: the figures shown must be the figures `js/evidence.js` computed, hostile strings must arrive escaped, and a failed load must leave a message and no table.

`provenance.test.js` covers the optional `provenance` annotation on a source and the root count derived from it. Two publishers restating one advisory are two names and one root of evidence; fixtures with a known answer pin that, and the validator must reject a malformed annotation, one mutation per rule. No real record is annotated, so every counted record currently reads `INDETERMINATE`. `docs/annotating-provenance.md` is the annotation guide. Each record card on the dashboard has a "Where the facts came from" section that draws those roots as a graph; `source-graph.test.js` checks it.

If you change a record, the suite will fail until you regenerate the baseline and the published summary:

```bash
node tests/update-expected.js   # then review the diff
node tests/derive.test.js
```

The diff is the review surface: it shows exactly which published totals your record change moved.

Three more tools, none required to pass:

```bash
node tests/find-archives.js    # look up a Wayback snapshot for every source URL
node tests/export-csv.js       # regenerate data/incidents.csv from the JSON
node scripts/provenance-report.js   # independence audit and the annotation backlog
node scripts/verify-provenance-quotes.js   # check each provenance quote against its archived snapshot
```

`find-archives.js` distinguishes three outcomes and never conflates them: a snapshot was found, no snapshot exists, or the lookup failed. A failed lookup leaves the source untouched, because a dataset that separates verified from unverified must not let its own tooling record an absence it did not observe.

It resumes by default, skipping sources already resolved, because each lookup takes roughly 40 seconds against a free public API. Pass `--recheck` to force a full pass. Current coverage across 29 source URLs: 16 with a snapshot, 13 confirmed to have none, none unresolved.

The confirmed absences are worth reading rather than skipping. Nearly all are machine-readable API endpoints under `cveawg.mitre.org/api/` and `services.nvd.nist.gov/rest/`, which web archives do not crawl. Reading an authoritative API gives the most exact data and the least durable citation. The methodology page records that trade-off instead of hiding it.

## The four breakdowns

Every record is reported by country, sector, vulnerability class, and consequence, each read from a single field. Each row shows two counts that are never added together: records that pass the headline rule, and records that stay visible but do not count, beside the rule that excluded them.

Two counters replace a single "incidents" figure. **Documented occurrences** are records whose sources describe an event. **Demonstrated capabilities** are records whose sources describe something shown to be possible. A fully-sourced CVE with no known exploitation belongs in the second group, and adding the two together would claim something the sources do not say.

Geography is grouped, never inferred. Records without a region established by their sources are collected under "not established by sources" rather than assigned to a country.

## Over time

A fifth view groups records by year, kept deliberately outside the four-axis grid. It is reported by **year of disclosure, not year of occurrence**, because every record has a disclosure date while incident dates are often approximate or unknown, and grouping by them would invent precision the sources do not support.

It carries a caveat the four axes do not need: a rising count measures disclosure and this dataset's own growing coverage, not how often these events happen. Presenting it as a peer of the four named axes would quietly imply it measures the world.

## Use the data elsewhere

`data/incidents.json` is the record of truth. `data/incidents.csv` is generated from it by `node tests/export-csv.js` for spreadsheet and statistical work, and should never be edited by hand.

Every CSV row carries `verification_status`, `evidence_grade` and `in_headline_totals`, so the eligibility rule travels with the data. Filter to `in_headline_totals = yes` to reproduce the figures on the page. The per-record flag columns describe every row including the ones the site does not count, so totalling `agent_caused` across the whole file gives a larger number than the page reports, by design.

Money columns stay separate and currency-tagged. They are read from `financial_loss_confirmed` and `financial_loss_estimated`, the same fields the page uses. `confirmed` and `estimated` are never merged into one column, because a spreadsheet will happily sum a mixed column and produce a figure no source supports. If a record carries a confirmed amount, the exporter refuses to write a CSV that omits it.

## Relying on the results from another system

Only one result means a record's evidence is independently confirmed: `INDEPENDENT_CONFIRMED`.
Check for it with `isConfirmed(verdict)`, or use `relianceDecision(sourceRoots(record))`, which
also returns stable reason codes when the answer is no. Never test for "not INDETERMINATE":
any other value, including one added later, must mean no.

`examples/consumer-policy.js` shows the full check a consumer should make. It denies by
default, and allows only when all of these hold:
- the versions are known;
- the data is not the demo set;
- the last review is recent;
- `data/summary.json` matches the data, by totals and by both checksums;
- the record is counted;
- its verdict permits reliance.

`dataset_checksum_sha256` covers the list of record ids. `dataset_content_sha256` covers every
field of every record: one SHA-256 per record over its canonical JSON, then one over the sorted
`id:hash` lines. A matching checksum proves the data and the summary agree. It does not prove
who published them; that would need signed releases.

Even `INDEPENDENT_CONFIRMED` means "confirmed under the reviewers' annotations", so a decision
with real stakes should keep a person in the loop.

## What’s in the box

| Path | Role |
| --- | --- |
| `index.html` | Public clock and the four breakdowns |
| `methodology.html` | Published rules |
| `data/incidents.json` | Seed records, source links, revision history. The record of truth |
| `data/incidents.csv` | Generated from the JSON by `tests/export-csv.js`. Never edited by hand |
| `data/summary.json` | Derived artifact, regenerated by `tests/update-expected.js` |
| `css/clock.css` | UI |
| `js/evidence.js` | All counter derivation, loaded by the page and the tests |
| `js/clock.js` | Rendering only |
| `js/source-graph.js` | Rendering only: the "Where the facts came from" graph on a record card |
| `js/methodology.js` | Rendering only: the sensitivity table and the independence audit on the methodology page |
| `tests/derive.test.js` | Counter and integrity tests |
| `tests/expected.json` | Pinned baseline for published totals |
| `tests/schema.js` | Allowed field vocabulary and shape rules |
| `tests/validate-records.js` | Field-level validation, run before the arithmetic |
| `tests/validate.test.js` | Mutations that arithmetic would swallow must fail validation |
| `tests/sensitivity.test.js` | The sensitivity table agrees with the published rule and the pinned baseline |
| `tests/methodology-render.test.js` | The methodology page renders that table escaped, and fails legibly |
| `tests/provenance.test.js` | Source-root fixtures, properties, and validator mutations for `provenance` |
| `tests/source-graph.test.js` | The source graph draws one box per source, escaped, with the audit's verdict |
| `tests/validate-provenance.js` | Validation of `provenance`: shape, evidence for every claim, registered outside origins |
| `tests/provenance-history.js` | Rejects a provenance change that is not a recorded revision; CI runs it against a PR's base |
| `tests/provenance-history.test.js` | Tests for that rule |
| `tests/consumer-policy.test.js` | The reference consumer denies on every broken condition, with its reason code |
| `tests/verify-provenance-quotes.test.js` | Offline tests for the quote checker, including rate limits and outages |
| `tests/codeowners.test.js` | Every path that decides the counts keeps a code owner |
| `data/external-roots.json` | Registry of outside origins a source may derive from |
| `examples/consumer-policy.js` | Reference consumer: denies by default, allows only a confirmed record from verified data |
| `scripts/content-digest.js` | Computes the content checksum in Node |
| `scripts/verify-provenance-quotes.js` | Checks each provenance quote against its archived snapshot. Needs the network; never blocks |
| `.github/CODEOWNERS` | Owner review for data, counting code, tests, scripts and CI |
| `scripts/provenance-report.js` | Prints the independence audit and the annotation backlog. Reads, never writes |
| `docs/annotating-provenance.md` | How to annotate a source's provenance. When in doubt, `UNKNOWN` |
| `tests/find-archives.js` | Wayback snapshot lookup for every source URL |
| `tests/export-csv.js` | Regenerates `data/incidents.csv` |
| `docs/CURRENT_STATE.md` | Before-snapshot of the seed preview at `1d51c76`. Not current figures |
| `IMPLEMENTATION_PROPOSAL.md` | Stack, timeline, ownership, assumptions |
| `CONTRIBUTING.md` | Fork + PR / submission rules |
| `CONTRIBUTORS.md` | Credit. Not ownership |
| `assets/concept-render.png` | Visual direction only |

`js/evidence.js` is the only file that computes a number. `js/clock.js`, `js/methodology.js` and `js/source-graph.js` render what they are given and nothing else, so a passing test run means the page cannot be displaying a figure the data does not support.

## What this is not

- Not a live global incident census
- Not production data
- Not an A2SPA advertisement
- Not a transfer of brand, domain, official dataset, or canonical repo ownership

Canonical repository, production deployment, and data governance stay with AI Blockchain Ventures LLC / AI Modularity.
