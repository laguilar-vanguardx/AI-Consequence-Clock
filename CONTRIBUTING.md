# Contributing

Canonical project control stays with AI Blockchain Ventures LLC / AI Modularity.

## License and contribution terms

No open-source license has been granted for this repository yet. The Apache-2.0 note in `IMPLEMENTATION_PROPOSAL.md` is a pending-counsel proposal, not the current license. Do not assume Apache-2.0 or any other OSI license until a `LICENSE` file is added.

The CLA decision is also pending counsel. Until that is settled, contributors should only submit material they have the right to contribute and should expect maintainers to ask for explicit contribution terms before accepting substantial code, data, or documentation changes.

## Code

1. Fork the canonical repository.
2. Open a pull request.
3. Do not expect production credentials.
4. Do not commit secrets, admin tokens, or private incident material.
5. Credit may appear in CONTRIBUTORS. Credit is not ownership.

Before opening a pull request, run all of:

```bash
node tests/validate-records.js
node tests/validate.test.js
node tests/derive.test.js
node tests/sensitivity.test.js
node tests/methodology-render.test.js
node tests/provenance.test.js
node tests/source-graph.test.js
node tests/consumer-policy.test.js
node tests/provenance-history.test.js
node tests/verify-provenance-quotes.test.js
node tests/codeowners.test.js
```

The same checks run automatically on every pull request, along with a check that the generated CSV and baseline match the JSON.

If you changed a record, the suite fails until you run `node tests/update-expected.js` and include the resulting baseline diff — that diff is how a reviewer sees which published totals your change moved.

Run the validator first. It catches the class of error the arithmetic cannot: a record whose `verification_status` reads `verified` in lowercase computes perfectly and silently drops out of every headline total, so the clock gets quieter and nothing reports an error anywhere. Field values are case-sensitive on purpose.

If you add a source, run `node tests/find-archives.js` so the URL is checked against the Internet Archive and a snapshot is recorded where one exists. It skips sources already resolved, so it will only look up yours. It edits the record, so run `node tests/update-expected.js` afterwards: `data/summary.json` publishes a checksum of every record's content. If the lookup fails, leave the fields untouched and say so in the pull request. Never write "no snapshot" for a lookup that did not complete — recording an absence you did not observe is the one thing this project cannot do.

Prefer a source URL that a web archive can actually capture. Authoritative JSON APIs give the most exact data and the least durable citation: every unarchivable source in this dataset is an API endpoint. If the only good source is an API, say so in `source_quality_basis` rather than pretending the link will outlive the service.

A source may carry an optional `provenance` annotation saying whether it is the original evidence or derives from another source. Read `docs/annotating-provenance.md` first. Annotate only what the source itself states, and when in doubt leave the source unannotated, which means `UNKNOWN`. Every claim needs a short quote and a Wayback Machine snapshot of the source, every outside origin must be registered in `data/external-roots.json`, and the change is a revision whose `change_log` entry lists `"changed": ["provenance"]`. Never generate these annotations with a tool.

If you changed a record, regenerate the CSV with `node tests/export-csv.js` and commit it, so the generated file never disagrees with the JSON it came from.

Two rules for code touching the page:

- **Treat every record field as hostile.** Records arrive from public submission. Anything interpolated into markup goes through the escape helper in `js/clock.js`, and any URL from a record goes through the URL check, which passes only `http` and `https`. A contributed `javascript:` link must render as no link at all.
- **Derive numbers in `js/evidence.js`, never in `js/clock.js`.** The rendering layer is deliberately incapable of computing a figure, which is what lets the test suite guarantee the page shows nothing the data does not support.

## Incident submissions

Public submissions should include:

- Neutral title and 1–3 sentence summary
- Incident date if known, disclosure date if known
- Why AI/agent behavior is material
- At least one attributable source URL
- Proposed category and severity

Submissions enter `UNDER_REVIEW`. They do not hit headline counters until a reviewer sets VERIFIED or CORROBORATED.

## Corrections

Factual disputes should include the incident id, the claimed error, and a source. Corrections create a new revision. They do not silently rewrite history.
