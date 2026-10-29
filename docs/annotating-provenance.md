# Annotating the provenance of a source

The published rule asks for "independently published" sources and checks that by counting
publisher names. Two outlets that rewrite the same advisory have two names and one root of
evidence. Provenance lets the project count roots.

Annotating is a human judgement. No tool in this repository does it for you, and none should:
it is not inferred from titles, from dates, or from how similar two texts look.

## The rule above all others

**When in doubt, `UNKNOWN`.** A source with no annotation is already `UNKNOWN`; there is nothing
to write. An `ORIGINAL` entered on a hunch manufactures independence nobody verified, which is
exactly the error this field exists to prevent. One `UNKNOWN` too many only leaves the record
`INDETERMINATE`, which is true.

## The fields

`id` and `provenance` are optional and live inside each element of `sources[]`. When
`provenance` is present, `kind` and both lists are required, `ORIGINAL` and `DERIVED` need
`evidence`, `ORIGINAL` needs `original_basis`, and `note` is optional. No other fields are
accepted.

```json
{
  "id": "nvd",
  "url": "https://nvd.nist.gov/vuln/detail/CVE-2024-8309",
  "publisher": "NIST National Vulnerability Database",
  "provenance": {
    "kind": "DERIVED",
    "derives_from_internal": ["cve"],
    "derives_from_external": [],
    "evidence": [
      {
        "supports": "cve",
        "quote": "Source: MITRE",
        "snapshot_url": "https://web.archive.org/web/20241030000000/https://nvd.nist.gov/vuln/detail/CVE-2024-8309"
      }
    ],
    "note": "The entry credits MITRE and reproduces the CVE record's description."
  }
}
```

(In a real annotation the quote must be 20 to 300 characters; this one is shortened.)

- `id`: lowercase slug (`a-z`, `0-9`, `-`), unique within the record. Required when the
  source declares `provenance`.
- `kind`:
  - `ORIGINAL`: the source produced the evidence itself (the tribunal that ruled, the
    researcher who found the flaw, the authority that assigned the CVE). Empty lists.
  - `DERIVED`: the source says where its claim came from. At least one reference.
  - `UNKNOWN`: you do not know, or the source does not say. Empty lists.
- `derives_from_internal`: ids of other sources **on the same record**.
- `derives_from_external`: roots that are not attached to the record, written `prefix:slug`.
  Allowed prefixes: `cve`, `vendor`, `paper`, `researcher`, `regulator`, `other`. For example
  `cve:CVE-2026-30306`, `vendor:acme-blog-2026-05-12` or `paper:arxiv-2401-12345`. Keys are
  compared without regard to case.
- `original_basis` (`ORIGINAL` only): why this source is the origin. One of `ISSUED_DECISION`
  (a court, tribunal or regulator decided it), `OWN_RESEARCH` (the source found it),
  `ASSIGNING_AUTHORITY` (the body that assigns the identifier, such as a CVE numbering
  authority) or `OWN_REPORTING` (original reporting, such as interviews or obtained documents).
- `evidence`: the proof, one entry per claim. For `ORIGINAL`, one entry with
  `"supports": "original"`. For `DERIVED`, one entry for each id or key it derives from, with
  `supports` set to that id or key. Each entry has:
  - `quote`: 20 to 300 characters copied word for word from the source, the passage that shows
    the claim (the credit, the link text, the "according to");
  - `snapshot_url`: a Wayback Machine capture of this same source,
    `https://web.archive.org/web/<14-digit timestamp>/<the source url>`.
  Anyone can open the snapshot and find the quote, without trusting the annotator. A script
  checks this too (see below).
- `note`: free text for anything the quote does not make obvious.

**A source with no Wayback capture cannot be `ORIGINAL` or `DERIVED`.** Request one first
with Save Page Now (`https://web.archive.org/save`), then run `node tests/find-archives.js`.
If the page cannot be captured, the source stays `UNKNOWN`.

**Outside origins must be registered.** Every `derives_from_external` key must be listed once in
`data/external-roots.json`, with a title and a URL for the origin itself. A `cve:` key must look
like `cve:cve-2024-8309`. Register a key before using it, and search the registry first: the
validator warns when two keys look like the same origin.

## How to decide

1. Open the source. Remembering where that publisher usually gets its material is not enough.
2. Does it say explicitly where its claim comes from (a link, a credit, "according to...")? Then
   it is `DERIVED`, and that passage is the quote in its evidence entry.
3. Is it the party that produced the evidence? Then it is `ORIGINAL`, with the passage that
   shows it and the matching `original_basis`.
4. Anything else, or no archived copy: `UNKNOWN`.

If the root is already attached to the record, cite it through `derives_from_internal`. Use
`derives_from_external` only for roots that are not in `sources[]`. Two sources citing the same
external key are joined, so the key must be spelled identically in both: before inventing one,
search the file for an existing key.

## What the calculation does by itself

These joins are not annotated; `js/evidence.js` always applies them:

- Same publisher (ignoring case and extra whitespace).
- Same URL host (ignoring `www.`).

The second is conservative on purpose: two different authors on one platform read as one root.
The possible error is counting too few roots, never too many.

Derivations are followed in one direction only: from a piece of evidence up to what it rests
on. Two sources that rest on the same thing are one root. A source that only cites others, such
as a roundup listing two independent reports, does not join those reports to each other.

## Reading the result

For each record the published rule counts:

| Verdict | Meaning |
| --- | --- |
| `INDEPENDENT_CONFIRMED` | Two or more roots holding a qualifying source, and no source in those roots left `UNKNOWN`. |
| `SINGLE_ROOT` | One root holding the qualifying sources, and no source in it left `UNKNOWN`. |
| `INDETERMINATE` | A qualifying source, or a source linked to one, is unannotated or `UNKNOWN`. |
| `NO_QUALIFYING_SOURCES` | No source is graded `PRIMARY` or `INDEPENDENT_SECONDARY`. |

This figure is published beside the frozen number and never replaces it. It does not change
which records count.

## Before opening the pull request

```bash
node tests/validate-records.js
node tests/provenance.test.js
node scripts/provenance-report.js
node scripts/verify-provenance-quotes.js
```

The validator rejects:
- malformed or repeated ids, and provenance on a source with no id;
- provenance that is not an object, unknown fields, an unknown `kind`, a `note` that is not text,
  and lists that are not arrays of strings;
- `ORIGINAL` or `UNKNOWN` that list a reference, and `DERIVED` with no reference;
- `ORIGINAL` without a valid `original_basis`, and `original_basis` on anything else;
- `ORIGINAL` or `DERIVED` without evidence for every claim, evidence for something the source
  does not claim, quotes outside 20 to 300 characters, and snapshots that are not a Wayback
  capture of the same source;
- evidence on an `UNKNOWN` source;
- references to sources that do not exist, self-references, and cycles;
- outside keys that are malformed or not registered.

A `DERIVED` source whose reference cannot be found is treated as untraced, so its record stays
`INDETERMINATE`.

`scripts/verify-provenance-quotes.js` fetches each snapshot and reports every quote as found,
not found, or lookup failed. It needs the network, so it is not part of the blocking suite; the
repository's "provenance quotes" workflow runs it on demand. It reads pages as UTF-8, so a page
in another encoding can report a quote as not found; open the snapshot and check by eye.

Annotating changes a record, so it is a revision:
- increase `revision`;
- add a `change_log` entry for that revision with `"changed": ["provenance"]`;
- follow CONTRIBUTING (`node tests/update-expected.js`, `node tests/export-csv.js`).

CI rejects a pull request that changes provenance without that entry. The regenerated
`tests/expected.json` shows which verdicts the annotation moved. Annotating never changes a
published number, only the shadow metric.
