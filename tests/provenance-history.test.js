/*
 * Tests for tests/provenance-history.js.
 *
 *   node tests/provenance-history.test.js
 *
 * Each case starts from the real data, changes one record, and checks whether the change
 * counts as a recorded revision.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");
const H = require(path.join(__dirname, "provenance-history.js"));

const base = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "incidents.json"), "utf8"));

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

const TARGET = base.incidents[0].id;
const ANNOTATION = { kind: "UNKNOWN", derives_from_internal: [], derives_from_external: [] };

/* A copy of the data where the target record is changed by `edit`. */
function headWith(edit) {
  const head = JSON.parse(JSON.stringify(base));
  edit(head.incidents.find((r) => r.id === TARGET));
  return head;
}
const annotate = (record) => {
  record.sources[0] = { ...record.sources[0], id: "s0", provenance: ANNOTATION };
};
const bump = (changed) => (record) => {
  record.revision = (record.revision || 1) + 1;
  record.change_log = (record.change_log || []).concat([
    { revision: record.revision, date: "2026-10-28", change: "Annotated a source.", changed }
  ]);
};
const ids = (problems) => problems.map((p) => p.id);

console.log("Provenance changes need a recorded revision");
check("unchanged data passes", H.annotationChanges(base, base), []);
check("an annotation with no revision bump is reported", ids(H.annotationChanges(base, headWith(annotate))), [TARGET]);
check(
  "a bump whose change_log does not list provenance is reported",
  ids(H.annotationChanges(base, headWith((r) => (annotate(r), bump(["sources"])(r))))),
  [TARGET]
);
check(
  "a bump whose change_log lists provenance passes",
  H.annotationChanges(base, headWith((r) => (annotate(r), bump(["provenance"])(r)))),
  []
);
/* The last entry already lists provenance, so only the revision number can tell the edits apart. */
const alreadyAnnotated = headWith((r) => (annotate(r), bump(["provenance"])(r)));
const editedAgain = JSON.parse(JSON.stringify(alreadyAnnotated));
editedAgain.incidents.find((r) => r.id === TARGET).sources[0].provenance = { ...ANNOTATION, note: "Changed again." };
check(
  "a second edit reusing the previous revision's entry is reported",
  ids(H.annotationChanges(alreadyAnnotated, editedAgain)),
  [TARGET]
);
check(
  "giving a source an id without annotating it is not a provenance change",
  H.annotationChanges(base, headWith((r) => (r.sources[0] = { ...r.sources[0], id: "s0" }))),
  []
);
check(
  "a change outside provenance is not this rule's concern",
  H.annotationChanges(base, headWith((r) => (r.title += " (edited)"))),
  []
);
check(
  "reordering sources is not a provenance change",
  H.annotationChanges(base, headWith((r) => r.sources.reverse())),
  []
);
check(
  "a new record is not compared with anything",
  H.annotationChanges({ incidents: [] }, headWith(annotate)),
  []
);
check("missing datasets give no problems instead of an error", H.annotationChanges(null, undefined), []);

console.log("\nCommand line");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provenance-history-"));
const write = (name, data) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
};
const run = (head) => {
  try {
    const script = path.join(__dirname, "provenance-history.js");
    execFileSync(process.execPath, [script, write("base.json", base), write("head.json", head)]);
    return 0;
  } catch (err) {
    return err.status;
  }
};
check("the command exits 0 when every change is recorded", run(base), 0);
check("the command exits 1 on an unrecorded change", run(headWith(annotate)), 1);
fs.rmSync(dir, { recursive: true });

console.log("\n" + "-".repeat(64));
if (failures.length) {
  console.log("FAILED: " + failures.length + " assertion(s) failed, " + passed + " passed.");
  process.exit(1);
}
console.log("PASSED: " + passed + " assertions.");
