/*
 * A change to a source's provenance must be a recorded revision, not a silent rewrite.
 *
 *   node tests/provenance-history.js <base incidents.json> <head incidents.json>
 *
 * CI runs it on a pull request with the PR's own base commit, so the result does not
 * depend on what else merged meanwhile. A record whose provenance changed must have a
 * higher revision, and its newest change_log entry must list "provenance" in `changed`.
 */

var fs = require("fs");
var path = require("path");
var E = require(path.join(__dirname, "..", "js", "evidence.js"));

/*
 * Provenance of every annotated source, keyed by source id (or url), in a form that ignores
 * order. Unannotated sources are left out, so giving a source an id is not a change.
 */
function provenanceSignature(record) {
  return (Array.isArray(record.sources) ? record.sources : [])
    .filter(function (source) {
      return source && typeof source === "object" && source.provenance !== undefined;
    })
    .map(function (source) {
      var key = typeof source.id === "string" ? source.id : String(source.url || "");
      return E.canonicalJson([key, source.provenance]);
    })
    .sort()
    .join("\n");
}

function records(dataset) {
  return dataset && Array.isArray(dataset.incidents) ? dataset.incidents : [];
}

function annotationChanges(base, head) {
  var before = Object.create(null);
  records(base).forEach(function (record) {
    if (record && typeof record.id === "string") before[record.id] = record;
  });
  var problems = [];
  records(head).forEach(function (record) {
    var old = record && before[record.id];
    if (!old || provenanceSignature(old) === provenanceSignature(record)) return;
    var revision = Number(record.revision) || 1;
    if (!(revision > (Number(old.revision) || 1))) {
      problems.push({ id: record.id, message: "provenance changed without a revision bump" });
      return;
    }
    var log = Array.isArray(record.change_log) ? record.change_log : [];
    var entry = log[log.length - 1];
    var changed = entry && Array.isArray(entry.changed) ? entry.changed : [];
    var listed = entry && entry.revision === revision && changed.indexOf("provenance") !== -1;
    if (!listed) {
      problems.push({
        id: record.id,
        message: 'provenance changed but change_log revision ' + revision + ' does not list "provenance" in changed'
      });
    }
  });
  return problems;
}

if (require.main === module) {
  var read = function (file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  var problems = annotationChanges(read(process.argv[2]), read(process.argv[3]));
  problems.forEach(function (p) {
    console.log("  " + p.id + " :: " + p.message);
  });
  console.log(
    problems.length
      ? "\nFAILED: provenance changed without a recorded revision."
      : "PASSED: every provenance change is a recorded revision."
  );
  if (problems.length) process.exit(1);
}

module.exports = { annotationChanges: annotationChanges, provenanceSignature: provenanceSignature };
