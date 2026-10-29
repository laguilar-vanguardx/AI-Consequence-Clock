/*
 * Record-level validation for data/incidents.json.
 *
 * Run: node tests/validate-records.js
 *
 * derive.test.js proves the arithmetic on whatever the file contains. This proves the
 * file contains what the methodology says a record is. The two failures it exists to
 * catch loudly rather than silently:
 *
 *   1. A value outside the published vocabulary. "verified" in lowercase matches no
 *      status, so the record quietly leaves every headline total with no error.
 *   2. A record whose grade is not the best grade among its attached sources, which
 *      would let a total assert evidence the file does not hold.
 */

var fs = require("fs");
var path = require("path");
var S = require(path.join(__dirname, "schema.js"));
var E = require(path.join(__dirname, "..", "js", "evidence.js"));
var P = require(path.join(__dirname, "validate-provenance.js"));

var REGISTRY_PATH = path.join(__dirname, "..", "data", "external-roots.json");

function readRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

/* Weakest first, so a higher index is a stronger grade. */
var GRADE_ORDER = ["ROUNDUP", "INDEPENDENT_SECONDARY", "PRIMARY"];

function bestSourceGrade(sources) {
  var best = -1;
  (sources || []).forEach(function (s) {
    best = Math.max(best, GRADE_ORDER.indexOf(s && s.evidence_grade));
  });
  return best === -1 ? null : GRADE_ORDER[best];
}

/* `options.registry` replaces data/external-roots.json, so tests can supply their own. */
function validateDataset(db, options) {
  var records = (db && db.incidents) || [];
  var problems = [];
  var warnings = [];
  var registry = options && options.registry ? options.registry : readRegistry();
  var checked = 0;
  var archivePresent = 0;
  var archiveAbsent = 0;
  var archiveUnchecked = 0;

function fail(id, message) {
  problems.push((id || "(no id)") + " :: " + message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function attachedSources(record) {
  return record.sources.filter(S.isPlainObject);
}

function qualifyingPublishers(sources) {
  var seen = {};
  sources.forEach(function (source) {
    var publisher = E.normalizePublisher(source.publisher);
    if (publisher && E.HEADLINE_GRADES.indexOf(source.evidence_grade) !== -1) seen[publisher] = true;
  });
  return Object.keys(seen);
}

/*
 * The checks below compare fields that state one fact twice. A disagreement moves no
 * total today, which is why nothing else would notice it.
 */
function checkDisclosureLag(record, id) {
  var lag = record.disclosure_lag_days;
  if (lag === undefined) {
    fail(id, "disclosure_lag_days is required: a number of days, or null when the lag is not known");
  } else if (lag !== null && (typeof lag !== "number" || !isFinite(lag))) {
    fail(id, "disclosure_lag_days must be a number or null");
  } else if (lag !== null && (record.incident_date === null || record.incident_date === undefined)) {
    fail(id, "disclosure_lag_days must be null when incident_date is null");
  }
}

function checkRollbackAgreement(record, id) {
  if (typeof record.rolled_back !== "boolean") return;
  if (record.rolled_back !== (record.reversibility === "rolled_back")) {
    fail(id, "rolled_back is " + record.rolled_back + ' but reversibility is "' + record.reversibility + '"');
  }
}

/* A roundup is a compilation of other reports, whatever grade it is given. */
function checkRoundupGrades(record, id) {
  record.sources.forEach(function (source, si) {
    if (!S.isPlainObject(source)) return;
    if (source.source_type === "security_research_roundup" && source.evidence_grade !== "ROUNDUP") {
      fail(id, "sources[" + si + "] is a security_research_roundup and cannot be graded above ROUNDUP");
    }
  });
}

/* The headline branch checks counted records. A feed-only CORROBORATED makes the same claim. */
function checkFeedOnlyCorroboration(record, id) {
  if (record.verification_status !== "CORROBORATED" || E.isHeadlineEligible(record)) return;
  if (qualifyingPublishers(attachedSources(record)).length < 2) {
    fail(id, "is CORROBORATED but carries fewer than two independently published qualifying sources");
  }
}

/* The headline branch reports this for counted records. A feed-only record makes the same claim. */
function checkFeedOnlyPrimaryUrl(record, id) {
  if (!nonEmptyString(record.primary_source_url) || E.isHeadlineEligible(record)) return;
  var attached = attachedSources(record).some(function (source) {
    return String(source.url).trim() === record.primary_source_url.trim();
  });
  if (!attached) fail(id, "primary_source_url is not among the attached sources");
}

var registryCheck = P.checkRegistry(registry);
registryCheck.problems.forEach(function (message) {
  fail("(registry)", message);
});
Array.prototype.push.apply(warnings, registryCheck.warnings);
var provenance = P.createChecker(fail, registry);

var seenIds = Object.create(null);

records.forEach(function (record, index) {
  var id = record && record.id ? record.id : "record[" + index + "]";

  if (!S.isPlainObject(record)) {
    fail(id, "record is not an object");
    return;
  }

  /* Identity */
  if (!nonEmptyString(record.id)) {
    fail(id, "id is required");
  } else {
    if (!S.ID_PATTERN.test(record.id)) {
      fail(id, "id must look like acc-<year>[-month][-day]-<slug>, lowercase");
    }
    if (seenIds[record.id]) fail(id, "duplicate id");
    seenIds[record.id] = true;
  }

  /* Required prose */
  S.REQUIRED_TEXT.forEach(function (field) {
    if (!nonEmptyString(record[field])) fail(id, field + " is required and must be non-empty");
    checked++;
  });

  /* Required booleans, not truthy strings */
  S.REQUIRED_BOOLEAN.forEach(function (field) {
    if (typeof record[field] !== "boolean") fail(id, field + " must be a boolean, got " + typeof record[field]);
    checked++;
  });

  /* Controlled vocabularies. Case-sensitive on purpose. */
  Object.keys(S.ENUMS).forEach(function (field) {
    var allowed = S.ENUMS[field];
    var value = record[field];
    if (value === undefined) {
      fail(id, field + " is required");
    } else if (allowed.indexOf(value) === -1) {
      fail(
        id,
        field + ' has unknown value "' + value + '". Allowed: ' + allowed.join(", ")
      );
    }
    checked++;
  });

  /* Every category must carry a published definition, so no class renders undefined. */
  if (record.category && !E.vulnerabilityDefinition(record.category)) {
    fail(id, 'category "' + record.category + '" has no definition in evidence.js VULNERABILITY_DEFINITIONS');
  }
  checked++;

  /* Geography: null means the sources did not establish one. A placeholder string does not. */
  if (record.country_region !== null && record.country_region !== undefined) {
    if (!nonEmptyString(record.country_region)) {
      fail(id, "country_region must be null or a non-empty region name");
    } else if (S.GEOGRAPHY_PLACEHOLDERS.indexOf(record.country_region.trim().toLowerCase()) !== -1) {
      fail(
        id,
        'country_region must be null when sources do not establish a region, not the placeholder "' +
          record.country_region +
          '"'
      );
    }
  }
  checked++;

  /* Dates */
  if (!nonEmptyString(record.disclosure_date) || !S.isValidIsoDate(record.disclosure_date)) {
    fail(id, "disclosure_date must be a real YYYY-MM-DD date");
  }
  if (record.incident_date !== null && record.incident_date !== undefined) {
    if (!S.isValidIsoDate(record.incident_date)) {
      fail(id, "incident_date must be null or a real YYYY-MM-DD date");
    } else if (record.disclosure_date && record.incident_date > record.disclosure_date) {
      fail(id, "incident_date " + record.incident_date + " is after disclosure_date " + record.disclosure_date);
    }
  }
  checked += 2;

  /* Stored lag must equal the dates it claims to describe. */
  if (record.incident_date && record.disclosure_date) {
    var computed = E.daysBetween(record.incident_date, record.disclosure_date);
    if (record.disclosure_lag_days !== computed) {
      fail(
        id,
        "disclosure_lag_days is " + record.disclosure_lag_days + " but the dates give " + computed
      );
    }
    checked++;
  }

  /* Money */
  S.moneyErrors("financial_loss_confirmed", record.financial_loss_confirmed).forEach(function (m) {
    fail(id, m);
  });
  S.moneyErrors("financial_loss_estimated", record.financial_loss_estimated).forEach(function (m) {
    fail(id, m);
  });
  checked += 2;

  /* Sources */
  if (!Array.isArray(record.sources) || record.sources.length === 0) {
    fail(id, "at least one source is required");
  } else {
    record.sources.forEach(function (source, si) {
      var where = "sources[" + si + "]";
      if (!S.isPlainObject(source)) {
        fail(id, where + " is not an object");
        return;
      }
      ["publisher", "title"].forEach(function (f) {
        if (!nonEmptyString(source[f])) fail(id, where + "." + f + " is required");
      });
      if (!nonEmptyString(source.url) || !/^https?:\/\//i.test(source.url.trim())) {
        fail(id, where + ".url must be an absolute http or https URL");
      }
      if (!nonEmptyString(source.publication_date) || !S.isValidIsoDate(source.publication_date)) {
        fail(id, where + ".publication_date must be a real YYYY-MM-DD date");
      }
      Object.keys(S.SOURCE_ENUMS).forEach(function (field) {
        var allowed = S.SOURCE_ENUMS[field];
        if (allowed.indexOf(source[field]) === -1) {
          fail(id, where + "." + field + ' has unknown value "' + source[field] + '". Allowed: ' + allowed.join(", "));
        }
      });

      /*
       * archived_url is optional, but a present value must be a real archive URL and
       * must be paired with a date. An undefined field means "not checked yet"; null
       * means "checked, nothing on file". The two are deliberately different.
       */
      if (source.archived_url !== undefined) {
        if (source.archived_url === null) {
          if (source.archived_at !== null) {
            fail(id, where + ".archived_at must be null when archived_url is null");
          }
          archiveAbsent++;
        } else if (!/^https:\/\/web\.archive\.org\/web\//.test(String(source.archived_url))) {
          fail(id, where + ".archived_url must be a https://web.archive.org/web/ URL or null");
        } else if (!S.isValidIsoDate(String(source.archived_at))) {
          fail(id, where + ".archived_at must be a real YYYY-MM-DD date when a snapshot is recorded");
        } else {
          archivePresent++;
        }
      } else {
        archiveUnchecked++;
      }
      checked += 6;
    });

    /*
     * "Grade is assigned from the sources listed on the record." The record grade must be
     * the best grade among its attached sources. Above it, a total asserts evidence the
     * file does not hold. Below it, the record understates what is attached, and a record
     * marked ROUNDUP over a qualifying source leaves the headline set with no error.
     */
    var best = bestSourceGrade(record.sources);
    if (best && S.ENUMS.evidence_grade.indexOf(record.evidence_grade) !== -1 && record.evidence_grade !== best) {
      fail(
        id,
        "evidence_grade is " + record.evidence_grade + " but the best attached source is " + best +
          ". Grade follows attached sources only."
      );
    }
    checked++;
  }

  checkDisclosureLag(record, id);
  checkRollbackAgreement(record, id);
  if (Array.isArray(record.sources)) {
    checkRoundupGrades(record, id);
    checkFeedOnlyCorroboration(record, id);
    checkFeedOnlyPrimaryUrl(record, id);
    provenance.checkRecord(record, id);
  }
  checked += 6;

  /*
   * The headline rule must be backed by the file. A record claiming a qualifying grade
   * needs a source that actually carries it, otherwise a published total asserts
   * evidence that is not attached.
   */
  if (E.isHeadlineEligible(record)) {
    var qualifying = (record.sources || []).filter(function (s) {
      return s && E.HEADLINE_GRADES.indexOf(s.evidence_grade) !== -1;
    });
    if (qualifying.length === 0) {
      fail(
        id,
        "is headline-eligible at " +
          record.evidence_grade +
          " but no attached source carries a qualifying grade"
      );
    }
    if (record.verification_status === "CORROBORATED") {
      if (qualifyingPublishers(qualifying).length < 2) {
        fail(
          id,
          "is CORROBORATED but carries fewer than two independently published qualifying sources"
        );
      }
    }
    /*
     * primary_source_url is the canonical citation, not a synonym for the grade. A
     * CORROBORATED record may legitimately have none, because no attached source is
     * PRIMARY. What must never happen is a citation pointing somewhere the record does
     * not actually cite, or a PRIMARY grade with no primary document named.
     */
    if (record.evidence_grade === "PRIMARY" && !nonEmptyString(record.primary_source_url)) {
      fail(id, "evidence_grade is PRIMARY but no primary_source_url is named");
    }
    if (nonEmptyString(record.primary_source_url)) {
      var urls = (record.sources || []).map(function (s) {
        return String(s && s.url).trim();
      });
      var cited = (record.sources || [])[urls.indexOf(record.primary_source_url.trim())];
      if (!cited) {
        fail(id, "primary_source_url is not among the attached sources");
      } else if (record.evidence_grade === "PRIMARY" && cited.evidence_grade !== "PRIMARY") {
        fail(
          id,
          "evidence_grade is PRIMARY but primary_source_url points at a " + cited.evidence_grade + " source"
        );
      }
    }
    checked += 3;
  }

  /*
   * Dates are checked against the dataset's own review date, not the wall clock, so the
   * suite stays deterministic. A disclosure after the last review cannot have been
   * reviewed, and the day counter would clamp it to 0 instead of reporting it.
   */
  if (
    S.isValidIsoDate(String(record.disclosure_date)) &&
    S.isValidIsoDate(String(db.last_evidence_review)) &&
    record.disclosure_date > db.last_evidence_review
  ) {
    fail(
      id,
      "disclosure_date " + record.disclosure_date + " is after last_evidence_review " + db.last_evidence_review
    );
  }
  checked++;

  /*
   * A revised record must say what changed, and the newest log entry must be for the
   * revision the record is at. A bumped revision over an old entry is a silent rewrite.
   */
  if (record.revision && record.revision > 1) {
    if (!Array.isArray(record.change_log) || record.change_log.length === 0) {
      fail(id, "revision " + record.revision + " requires a change_log entry");
    } else {
      var last = record.change_log[record.change_log.length - 1];
      if (!S.isPlainObject(last) || last.revision !== record.revision) {
        fail(
          id,
          "revision is " + record.revision + " but the last change_log entry names " +
            (S.isPlainObject(last) && last.revision !== undefined ? "revision " + last.revision : "no revision")
        );
      }
    }
    checked++;
  }
});

  /* Dataset-level */
  if (!nonEmptyString(db.last_evidence_review) || !S.isValidIsoDate(db.last_evidence_review)) {
    fail("(dataset)", "last_evidence_review must be a real YYYY-MM-DD date");
  }
  checked++;

  provenance.unusedRoots().forEach(function (key) {
    warnings.push('registry key "' + key + '" is not used by any source');
  });

  return {
    problems: problems,
    warnings: warnings,
    checked: checked,
    archivePresent: archivePresent,
    archiveAbsent: archiveAbsent,
    archiveUnchecked: archiveUnchecked,
    recordCount: records.length
  };
}

function report(result) {
  console.log("Validated " + result.recordCount + " records, " + result.checked + " field checks.");
  /*
   * Reported, not enforced. Archive coverage depends on a third party being reachable, so
   * failing the build on it would make the suite non-deterministic. Surfacing it keeps the
   * link-rot exposure visible instead of invisible.
   */
  console.log(
    "Source archive coverage: " +
      result.archivePresent +
      " snapshot, " +
      result.archiveAbsent +
      " confirmed none, " +
      result.archiveUnchecked +
      " not yet checked. Run: node tests/find-archives.js"
  );
  /* Warnings point at likely mistakes a person should look at; they never fail the build. */
  (result.warnings || []).forEach(function (w) {
    console.log("Warning: " + w);
  });
  if (result.problems.length) {
    console.log("\n" + result.problems.length + " problem(s):\n");
    result.problems.forEach(function (p) {
      console.log("  " + p);
    });
    console.log("\nFAILED record validation.");
    process.exit(1);
  }
  console.log("PASSED record validation.");
}

if (require.main === module) {
  var db = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "incidents.json"), "utf8"));
  report(validateDataset(db));
}

module.exports = { validateDataset: validateDataset };
