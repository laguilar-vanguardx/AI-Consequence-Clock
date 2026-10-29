/*
 * Evidence layer for the AI Consequence Clock preview.
 *
 * One module, loaded by both the browser and Node, so the arithmetic shown on
 * the page is the arithmetic under test. No build step: a plain script tag
 * assigns window.ClockEvidence, and require() picks up module.exports.
 *
 * Every function here is pure and takes records as an argument. Nothing in this
 * file reads the network, the clock, or the DOM. "Today" is always injected so
 * a day counter can be tested and cannot freeze against a literal date.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ClockEvidence = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Published headline rule. Both conditions must hold.
  var HEADLINE_STATUSES = ["VERIFIED", "CORROBORATED"];
  var HEADLINE_GRADES = ["PRIMARY", "INDEPENDENT_SECONDARY"];

  // Agent causation is a field, never a text match on title or summary.
  var AGENT_ROLES = ["agent_initiated", "agent_executed"];

  var AUTH_GAP = "none_documented";

  // Geography is grouped only where a record names a region. These values mean
  // the sources did not establish one, and they are never resolved to a country.
  var GEO_UNSUPPORTED = ["Unknown", "unknown", "", null, undefined];

  function has(list, value) {
    return list.indexOf(value) !== -1;
  }

  function isHeadlineEligible(record) {
    return (
      has(HEADLINE_STATUSES, record.verification_status) &&
      has(HEADLINE_GRADES, record.evidence_grade)
    );
  }

  /*
   * The sentence after "review state is X" on a status-only exclusion. It must describe
   * the state the record is actually in: telling a retracted record it was excluded for
   * having a single source would publish a false reason on the card.
   */
  var STATUS_REASONS = {
    REPORTED: "A single qualifying source is REPORTED, not CORROBORATED.",
    UNDER_REVIEW: "It is waiting for a reviewer and does not count until one sets VERIFIED or CORROBORATED.",
    DISPUTED: "Its facts are disputed, so it does not count while the dispute is open.",
    RETRACTED: "It has been retracted. It stays in the feed so the correction is visible, but does not count."
  };
  var STATUS_REASON_OTHER = "Only VERIFIED and CORROBORATED records count.";

  /*
   * Why a record is not in the headline totals, in the same two axes the
   * methodology defines. A visitor seeing a total of 4 out of 10 needs this or
   * the missing six look like an omission instead of the rule working.
   */
  function exclusion(record) {
    if (isHeadlineEligible(record)) return null;
    var statusFails = !has(HEADLINE_STATUSES, record.verification_status);
    var gradeFails = !has(HEADLINE_GRADES, record.evidence_grade);
    var code = statusFails && gradeFails ? "status_and_grade" : statusFails ? "status" : "grade";
    var detail;
    if (code === "status_and_grade") {
      detail =
        "Review state is " + record.verification_status + " and attached evidence is " +
        record.evidence_grade + ". Both fail the headline rule.";
    } else if (code === "status") {
      detail =
        "Evidence grade " + record.evidence_grade + " qualifies, but review state is " +
        record.verification_status + ". " + (STATUS_REASONS[record.verification_status] || STATUS_REASON_OTHER);
    } else {
      detail =
        "Review state " + record.verification_status + " qualifies, but attached evidence is " +
        record.evidence_grade + ", which cannot enter headline totals.";
    }
    return { code: code, status_fails: statusFails, grade_fails: gradeFails, detail: detail };
  }

  /*
   * Separates a documented occurrence from a demonstrated capability.
   *
   * A tribunal decision and a research proof-of-concept are both sourced, and
   * both belong on the page, but adding them into one number labelled
   * "incidents" claims something happened when the source says it was shown to
   * be possible. Derived from the existing adversary field only.
   */
  function occurrence(record) {
    return record.adversary === "research_demo" ? "demonstrated" : "documented";
  }

  /*
   * causal_role describes the mechanism a source attributes the behaviour to. On a
   * vulnerability record it describes what the flaw would let an agent do, not
   * something an agent did. Counting those as agent-caused would report capabilities
   * as events, so the count is restricted to documented occurrences. Demonstrated
   * capabilities are reported separately and never folded into this number.
   */
  function isAgentCaused(record) {
    return has(AGENT_ROLES, record.causal_role) && occurrence(record) === "documented";
  }

  function isAuthGap(record) {
    return record.authorization_evidence === AUTH_GAP;
  }

  function isUnauthorizedClaim(record) {
    // The field is a tri-state string. Only an explicit "true" counts.
    return record.unauthorized_claim === "true" || record.unauthorized_claim === true;
  }

  function geographySupported(record) {
    return !has(GEO_UNSUPPORTED, record.country_region);
  }

  function daysBetween(from, to) {
    if (!from || !to) return null;
    var ms = Date.parse(to) - Date.parse(from);
    if (!isFinite(ms)) return null;
    return Math.round(ms / 86400000);
  }

  /*
   * Days since the most recent disclosure in the dataset. `today` is required
   * so this value moves with the calendar instead of freezing at the date the
   * seed file was generated.
   */
  function daysSinceLatestDisclosure(records, today) {
    var dated = records.filter(function (r) {
      return !!r.disclosure_date;
    });
    if (!dated.length) return null;
    var latest = dated
      .slice()
      .sort(function (a, b) {
        return Date.parse(b.disclosure_date) - Date.parse(a.disclosure_date);
      })[0];
    var d = daysBetween(latest.disclosure_date, today);
    if (d === null) return null;
    return { days: Math.max(0, d), record: latest };
  }

  /*
   * Confirmed amounts only, grouped by currency and never summed across them.
   * The estimate field is not read here at all.
   */
  function confirmedMoney(records) {
    var byCurrency = {};
    records.forEach(function (r) {
      var row = r.financial_loss_confirmed;
      if (!row || typeof row.amount !== "number" || !row.currency) return;
      if (!byCurrency[row.currency]) byCurrency[row.currency] = { amount: 0, ids: [] };
      byCurrency[row.currency].amount += row.amount;
      byCurrency[row.currency].ids.push(r.id);
    });
    return byCurrency;
  }

  function estimatedMoney(records) {
    var rows = [];
    records.forEach(function (r) {
      var row = r.financial_loss_estimated;
      if (!row || typeof row.amount !== "number" || !row.currency) return;
      rows.push({ id: r.id, amount: row.amount, currency: row.currency, note: row.note || null });
    });
    return rows;
  }

  // The four axes named in the brief: country, sector, vulnerability, consequence.
  var AXES = {
    country: {
      key: "country_region",
      title: "Country or region",
      note: "Grouped only where a record's sources establish a location. Never inferred."
    },
    sector: {
      key: "sector",
      title: "Sector",
      note: "The sector of the organization named on the record."
    },
    vulnerability: {
      key: "category",
      title: "Vulnerability class",
      note: "The failure mechanism recorded on the incident, not a vendor rating."
    },
    consequence: {
      key: "consequence_class",
      title: "Consequence",
      note: "What the sources show was actually affected."
    },
    /*
     * Year of disclosure, not of occurrence. Disclosure is the date the evidence became
     * public and is present on every record; incident dates are often unknown or
     * approximate, so grouping by them would invent precision. A rising count here
     * measures disclosure and this dataset's own coverage, not the rate of events.
     */
    year: {
      value: function (record) {
        var d = record.disclosure_date;
        return d && /^\d{4}/.test(d) ? d.slice(0, 4) : null;
      },
      title: "Year of disclosure",
      note: "When the evidence became public, not when the event happened. Counts reflect disclosure and this dataset's coverage.",
      order: "value"
    }
  };

  /*
   * Groups records along one axis. Every group reports headline-eligible and
   * feed-only counts separately, and never a single blended total, so no row on
   * the page can imply more verified evidence than exists.
   */
  function groupByAxis(records, axisName) {
    var axis = AXES[axisName];
    if (!axis) throw new Error("Unknown axis: " + axisName);
    var groups = {};

    records.forEach(function (record) {
      var raw = axis.value ? axis.value(record) : record[axis.key];
      var supported = axisName === "country" ? geographySupported(record) : !!raw;
      // Readable sentinel: this value appears in shareable deep links.
      var value = supported ? raw : "not-established";
      if (!groups[value]) {
        groups[value] = {
          axis: axisName,
          value: value,
          label: supported ? String(raw) : "Not established by sources",
          supported: supported,
          headline: 0,
          excluded: 0,
          total: 0,
          documented: 0,
          demonstrated: 0,
          exclusions: { status: 0, grade: 0, status_and_grade: 0 },
          headline_ids: [],
          excluded_ids: []
        };
      }
      var g = groups[value];
      g.total += 1;
      var ex = exclusion(record);
      if (ex) {
        g.excluded += 1;
        g.exclusions[ex.code] += 1;
        g.excluded_ids.push(record.id);
      } else {
        g.headline += 1;
        g.headline_ids.push(record.id);
        g[occurrence(record)] += 1;
      }
    });

    return Object.keys(groups)
      .map(function (k) {
        return groups[k];
      })
      .sort(function (a, b) {
        // Unsupported values sort last so they never read as a real group.
        if (a.supported !== b.supported) return a.supported ? -1 : 1;
        // A time axis must stay in time order. Sorting years by size would hide the shape.
        if (axis.order === "value") return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
        if (b.headline !== a.headline) return b.headline - a.headline;
        if (b.total !== a.total) return b.total - a.total;
        return a.label.localeCompare(b.label);
      });
  }

  function averageDisclosureLag(records) {
    var lags = records
      .map(function (r) {
        return typeof r.disclosure_lag_days === "number"
          ? r.disclosure_lag_days
          : daysBetween(r.incident_date, r.disclosure_date);
      })
      .filter(function (d) {
        return d !== null && d >= 0;
      });
    if (!lags.length) return { average: null, n: 0 };
    var sum = lags.reduce(function (a, b) {
      return a + b;
    }, 0);
    return { average: Math.round(sum / lags.length), n: lags.length };
  }

  /*
   * The whole derivation, in one pass, from records to every number the page
   * shows. Nothing downstream is allowed to compute a total of its own.
   */
  function derive(dataset, today) {
    var records = (dataset && dataset.incidents) || [];
    var headline = records.filter(isHeadlineEligible);
    var excluded = records.filter(function (r) {
      return !isHeadlineEligible(r);
    });
    var lag = averageDisclosureLag(headline);
    var since = daysSinceLatestDisclosure(records, today);

    return {
      methodology_version: (dataset && dataset.methodology_version) || null,
      dataset_status: (dataset && dataset.dataset_status) || null,
      generated_at: (dataset && dataset.generated_at) || null,

      record_count: records.length,
      headline_count: headline.length,
      excluded_count: excluded.length,
      headline_ids: headline.map(function (r) {
        return r.id;
      }),

      // Occurrence split. These two are never added together on the page.
      documented_occurrences: headline.filter(function (r) {
        return occurrence(r) === "documented";
      }).length,
      demonstrated_capabilities: headline.filter(function (r) {
        return occurrence(r) === "demonstrated";
      }).length,

      agent_caused: headline.filter(isAgentCaused).length,
      unauthorized_actions: headline.filter(isUnauthorizedClaim).length,
      authorization_gap: headline.filter(isAuthGap).length,

      human_interventions: headline.filter(function (r) {
        return r.human_intervention === true;
      }).length,
      rolled_back: headline.filter(function (r) {
        return r.reversibility === "rolled_back";
      }).length,
      irreversible: headline.filter(function (r) {
        return r.reversibility === "irreversible";
      }).length,

      confirmed_money: confirmedMoney(headline),
      estimated_money: estimatedMoney(records),

      disclosure_lag_average: lag.average,
      disclosure_lag_n: lag.n,
      days_since_latest_disclosure: since ? since.days : null,
      latest_disclosure_record: since ? since.record : null,

      axes: {
        country: groupByAxis(records, "country"),
        sector: groupByAxis(records, "sector"),
        vulnerability: groupByAxis(records, "vulnerability"),
        consequence: groupByAxis(records, "consequence"),
        year: groupByAxis(records, "year")
      },

      geography_unsupported: records.filter(function (r) {
        return !geographySupported(r);
      }).length
    };
  }

  function sorted(values) {
    return (values || []).slice().sort();
  }

  function json(value) {
    return JSON.stringify(value);
  }

  function moneyAmounts(confirmedMoney) {
    return Object.keys(confirmedMoney || {})
      .sort()
      .reduce(function (acc, currency) {
        var row = confirmedMoney[currency];
        acc[currency] = row && typeof row.amount === "number" ? row.amount : row;
        return acc;
      }, {});
  }

  function axisSummary(axes) {
    return Object.keys(axes || {})
      .sort()
      .reduce(function (acc, axisName) {
        acc[axisName] = (axes[axisName] || []).map(function (g) {
          return {
            label: g.label,
            supported: g.supported,
            headline: g.headline,
            excluded: g.excluded
          };
        });
        return acc;
      }, {});
  }

  function publishedProjection(summary) {
    return {
      record_count: summary.record_count,
      eligible_record_count: summary.headline_count,
      record_ids: sorted(summary.headline_ids),
      hero_count: summary.authorization_gap,
      occurrence_split: {
        documented_occurrences: summary.documented_occurrences,
        demonstrated_capabilities: summary.demonstrated_capabilities
      },
      agent_caused: summary.agent_caused,
      unauthorized_actions: summary.unauthorized_actions,
      confirmed_money: moneyAmounts(summary.confirmed_money),
      geography_not_established: summary.geography_unsupported,
      axes: axisSummary(summary.axes)
    };
  }

  function normalizedPublished(published) {
    return {
      record_count: published.record_count,
      eligible_record_count: published.eligible_record_count,
      record_ids: sorted(published.record_ids),
      hero_count: published.hero_count,
      occurrence_split: {
        documented_occurrences: published.occurrence_split && published.occurrence_split.documented_occurrences,
        demonstrated_capabilities: published.occurrence_split && published.occurrence_split.demonstrated_capabilities
      },
      agent_caused: published.agent_caused,
      unauthorized_actions: published.unauthorized_actions,
      confirmed_money: published.confirmed_money || {},
      geography_not_established: published.geography_not_established,
      axes: axisSummary(published.axes)
    };
  }

  /*
   * One serialization for the same data in Node and in the browser: object keys sorted
   * by UTF-16 code unit at every level, as in RFC 8785, and numbers as JSON.stringify
   * prints them. Hashing is left to the caller, so this module stays synchronous and pure.
   */
  function canonicalJson(value) {
    if (value === null || value === undefined || typeof value !== "object") {
      return JSON.stringify(value === undefined ? null : value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map(canonicalJson).join(",") + "]";
    }
    var fields = Object.keys(value)
      .sort()
      .filter(function (key) {
        return value[key] !== undefined;
      })
      .map(function (key) {
        return JSON.stringify(key) + ":" + canonicalJson(value[key]);
      });
    return "{" + fields.join(",") + "}";
  }

  /*
   * recordHashes is [{ id, hash }], one hash per record; the caller hashes the text this
   * returns. Lines are sorted, so the order of records in the file does not matter.
   */
  function contentChecksumText(recordHashes) {
    return recordHashes
      .map(function (entry) {
        return String(entry.id) + ":" + String(entry.hash);
      })
      .sort()
      .join("\n");
  }

  /* A 64-character hex string, as SHA-256 prints. Anything else means "not available". */
  function isDigest(value) {
    return /^[0-9a-f]{64}$/i.test(String(value || ""));
  }

  /*
   * The footer says whether the browser recomputation agrees with data/summary.json.
   * The old check used only a checksum of all incident ids, so changing a record from
   * PRIMARY to ROUNDUP left the digest unchanged while the headline count moved. Compare
   * the published totals themselves, and reserve checksum-only states for actual checksum
   * availability/fetch problems.
   *
   * `digests` is either the id digest as a string, as callers have always passed it, or
   * { idDigest, contentDigest }. The content digest covers every field of every record,
   * so it catches an edit the id digest cannot see.
   */
  function comparePublishedSummary(summary, published, digests) {
    var given = digests !== null && typeof digests === "object" ? digests : { idDigest: digests };
    var digest = given.idDigest;
    if (!published) {
      return {
        status: "unavailable",
        matches: false,
        mismatches: [],
        label: "summary.json unavailable; recomputed in browser"
      };
    }

    var expected = publishedProjection(summary);
    var actual = normalizedPublished(published);
    var mismatches = Object.keys(expected).filter(function (key) {
      return json(expected[key]) !== json(actual[key]);
    });

    if (isDigest(digest) && published.dataset_checksum_sha256 !== digest) {
      mismatches.push("dataset_checksum_sha256");
    }
    if (isDigest(given.contentDigest) && published.dataset_content_sha256 !== given.contentDigest) {
      mismatches.push("dataset_content_sha256");
    }

    if (mismatches.length) {
      return {
        status: "differs",
        matches: false,
        mismatches: mismatches,
        label: "differs from summary.json: " + mismatches.slice(0, 3).join(", ")
      };
    }

    if (!isDigest(digest)) {
      return {
        status: "matches_without_checksum",
        matches: true,
        mismatches: [],
        label: "derived totals match summary.json; checksum unavailable"
      };
    }

    return { status: "matches", matches: true, mismatches: [], label: "matches summary.json" };
  }

  /*
   * Neutral definitions for the vulnerability classes present in the data.
   * Written from the field taxonomy in METHODOLOGY_DIRECTION.md. Any class not
   * listed renders without a definition rather than with an invented one.
   */
  var VULNERABILITY_DEFINITIONS = {
    prompt_injection:
      "Untrusted input reached the model's context and changed what the system did or revealed. The instruction came from content, not from the operator.",
    unauthorized_action:
      "The system took an action the record's sources describe as outside documented approval, scope, or policy.",
    data_exposure:
      "Data was exposed, leaked, or accessed outside approved handling, whether or not an attacker was involved.",
    data_destruction:
      "Data or backups were deleted or overwritten by the system's own execution.",
    policy_misrepresentation:
      "The system stated a policy, price, or commitment that the operator did not hold, and the statement was treated as the operator's own.",
    containment_failure:
      "The boundary relied on to make model-generated or untrusted code safe to run did not hold, so execution reached the host it was meant to be isolated from.",
    fabricated_output:
      "The system produced confident content that does not exist or does not say what it was cited as saying, and that content was relied on as genuine."
  };

  function vulnerabilityDefinition(category) {
    return VULNERABILITY_DEFINITIONS[category] || null;
  }

  /*
   * The headline rule is one defensible choice among several. Each rule set below contains
   * every record the previous one does, so the table shows how far the published total moves
   * when the rule moves. R3 reads the published constants, so it cannot drift from them.
   */
  var RULE_SETS = [
    {
      id: "R1",
      label: "Strictest",
      rationale: "Two sources agree, and the official record itself is attached.",
      statuses: ["CORROBORATED"],
      grades: ["PRIMARY"]
    },
    {
      id: "R2",
      label: "Strict",
      rationale: "Checked by a reviewer, and the official record itself is attached.",
      statuses: ["VERIFIED", "CORROBORATED"],
      grades: ["PRIMARY"]
    },
    {
      id: "R3",
      label: "Standard",
      rationale: "Checked by a reviewer, with the official record or an independent news report attached.",
      published: true,
      statuses: HEADLINE_STATUSES.slice(),
      grades: HEADLINE_GRADES.slice()
    },
    {
      id: "R4",
      label: "Including records under review",
      rationale: "The published rule, plus records a reviewer has not finished checking.",
      statuses: ["VERIFIED", "CORROBORATED", "UNDER_REVIEW"],
      grades: ["PRIMARY", "INDEPENDENT_SECONDARY"]
    },
    {
      id: "R5",
      label: "Everything not disputed or retracted",
      rationale: "Adds reports nobody has verified, and records backed only by a roundup article.",
      statuses: ["REPORTED", "UNDER_REVIEW", "VERIFIED", "CORROBORATED"],
      grades: ["ROUNDUP", "INDEPENDENT_SECONDARY", "PRIMARY"]
    },
    {
      id: "R6",
      label: "Every record in the file",
      rationale: "No filter at all, including disputed and retracted records.",
      statuses: ["REPORTED", "UNDER_REVIEW", "VERIFIED", "CORROBORATED", "DISPUTED", "RETRACTED"],
      grades: ["ROUNDUP", "INDEPENDENT_SECONDARY", "PRIMARY"]
    }
  ];

  /* One row per rule set. Documented and demonstrated stay in separate columns. */
  function sensitivityTable(records) {
    return RULE_SETS.map(function (ruleSet) {
      var picked = (records || []).filter(function (record) {
        return has(ruleSet.statuses, record.verification_status) && has(ruleSet.grades, record.evidence_grade);
      });
      var documented = picked.filter(function (record) {
        return occurrence(record) === "documented";
      }).length;
      return {
        id: ruleSet.id,
        label: ruleSet.label,
        rationale: ruleSet.rationale,
        published: !!ruleSet.published,
        total: picked.length,
        documented: documented,
        demonstrated: picked.length - documented,
        ids: picked.map(function (record) { return record.id; }).sort()
      };
    });
  }

  /*
   * Source provenance. Two publishers restating one advisory are one root of evidence.
   * The headline rule counts publisher names. This counts roots and changes no published
   * number. Nothing is inferred: a source with no annotation is UNKNOWN.
   */
  var PROVENANCE_KINDS = ["ORIGINAL", "DERIVED", "UNKNOWN"];
  var EXTERNAL_ROOT_PREFIXES = ["cve", "vendor", "paper", "researcher", "regulator", "other"];
  var EXTERNAL_ROOT_KEY = new RegExp("^(" + EXTERNAL_ROOT_PREFIXES.join("|") + "):[a-z0-9][a-z0-9.-]*$", "i");
  var SOURCE_ID = /^[a-z0-9][a-z0-9-]*$/;
  var VERDICT_DEFINITIONS = [
    {
      id: "INDEPENDENT_CONFIRMED",
      label: "Independently confirmed",
      text: "Two or more separate pieces of evidence, and every source behind them has its origin recorded."
    },
    {
      id: "SINGLE_ROOT",
      label: "One piece of evidence",
      text: "The sources lead back to one piece of evidence, and every source behind it has its origin recorded."
    },
    {
      id: "INDETERMINATE",
      label: "Not known yet",
      text: "At least one source has no origin recorded, so no conclusion is drawn."
    },
    {
      id: "NO_QUALIFYING_SOURCES",
      label: "No qualifying source",
      text: "No attached source is strong enough to count."
    }
  ];
  var PROVENANCE_VERDICTS = VERDICT_DEFINITIONS.map(function (definition) {
    return definition.id;
  });
  // Frozen so no consumer can add a verdict, or rename one, at runtime.
  VERDICT_DEFINITIONS.forEach(Object.freeze);
  Object.freeze(VERDICT_DEFINITIONS);
  Object.freeze(PROVENANCE_VERDICTS);

  function verdictDefinition(verdict) {
    return VERDICT_DEFINITIONS[PROVENANCE_VERDICTS.indexOf(verdict)] || null;
  }

  /*
   * The one verdict that permits reliance. An allow-list, not a deny-list: any other value,
   * including one added in a later version, is "not confirmed".
   */
  function isConfirmed(verdict) {
    return verdict === "INDEPENDENT_CONFIRMED";
  }

  var RELIANCE_REASONS = Object.freeze({
    NOT_CONFIRMED: "NOT_CONFIRMED",
    PENDING_SOURCES: "PENDING_SOURCES"
  });

  /* Whether a sourceRoots() result may be relied on, and if not, why, as stable codes. */
  function relianceDecision(roots) {
    var verdict = roots && typeof roots.verdict === "string" ? roots.verdict : null;
    if (isConfirmed(verdict)) return { allowed: true, verdict: verdict, reasons: [] };
    var reasons = [
      {
        code: RELIANCE_REASONS.NOT_CONFIRMED,
        message: "Only INDEPENDENT_CONFIRMED permits reliance. This record is " + String(verdict) + "."
      }
    ];
    var pending = roots && Array.isArray(roots.pending_sources) ? roots.pending_sources : [];
    if (pending.length) {
      reasons.push({
        code: RELIANCE_REASONS.PENDING_SOURCES,
        message: "Sources still to annotate before a verdict can be reached.",
        sources: pending.map(function (source) {
          return typeof source.id === "string" ? source.id : String(source.url || "");
        })
      });
    }
    return { allowed: false, verdict: verdict, reasons: reasons };
  }

  function normalizePublisher(value) {
    return String(value === null || value === undefined ? "" : value)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function urlHost(value) {
    var match = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]*)/i.exec(String(value || "").trim());
    if (!match) return "";
    return match[1]
      .replace(/^.*@/, "")
      .replace(/:\d*$/, "")
      .toLowerCase()
      .replace(/^www\./, "");
  }

  function provenanceKind(source) {
    var kind = source && source.provenance && source.provenance.kind;
    return has(PROVENANCE_KINDS, kind) ? kind : "UNKNOWN";
  }

  function stringList(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(function (item) {
      return typeof item === "string" && item.length > 0;
    });
  }

  /* First occurrence order, with a keyed lookup so long lists stay linear. Values are strings. */
  function distinct(values) {
    var seen = Object.create(null);
    return values.filter(function (value) {
      if (seen[value]) return false;
      seen[value] = true;
      return true;
    });
  }

  function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function isQualifyingSource(source) {
    return has(HEADLINE_GRADES, source.evidence_grade);
  }

  /* Only a DERIVED source names what it rests on. */
  function derivedFrom(source, field) {
    if (provenanceKind(source) !== "DERIVED") return [];
    return stringList(source.provenance[field]);
  }

  /* External keys match without regard to case. */
  function externalRootsOf(source) {
    return derivedFrom(source, "derives_from_external").map(function (key) {
      return key.toLowerCase();
    });
  }

  /* What one source declares, as the derivation reads it. For drawing, never for counting. */
  function sourceLinks(source) {
    return {
      kind: provenanceKind(source),
      qualifying: !!source && isQualifyingSource(source),
      internal: derivedFrom(source, "derives_from_internal"),
      external: externalRootsOf(source)
    };
  }

  /*
   * True when a source's own annotation cannot be followed: it is UNKNOWN, it is DERIVED
   * from nothing that can be found, or it contradicts itself. The page does not run the
   * validator, so a malformed annotation must not read as a traced one.
   */
  function isUntraced(source, attachedIds) {
    var kind = provenanceKind(source);
    var declared = source.provenance || {};
    var internal = stringList(declared.derives_from_internal);
    var external = stringList(declared.derives_from_external);
    if (kind === "UNKNOWN") return true;
    if (kind === "ORIGINAL") return internal.length + external.length > 0;
    var unresolved = internal.some(function (ref) {
      return attachedIds[ref] !== true;
    });
    return unresolved || internal.length + external.length === 0;
  }

  function sourceNodes(record) {
    var sources = (Array.isArray(record && record.sources) ? record.sources : []).filter(function (source) {
      return !!source && typeof source === "object";
    });
    var attachedIds = Object.create(null);
    sources.forEach(function (source) {
      if (typeof source.id === "string") attachedIds[source.id] = true;
    });
    return sources
      .map(function (source) {
        var id = typeof source.id === "string" ? source.id : "";
        var label = id || String(source.url || "");
        var publisher = normalizePublisher(source.publisher);
        return {
          source: source,
          id: id,
          label: label,
          publisher: publisher,
          qualifying: isQualifyingSource(source),
          original: provenanceKind(source) === "ORIGINAL",
          untraced: isUntraced(source, attachedIds),
          sortKey: [label, publisher, String(source.evidence_grade)].join("\n")
        };
      })
      // Sorted so the output does not depend on source order.
      .sort(function (a, b) {
        return compareStrings(a.sortKey, b.sortKey);
      })
      .map(function (node, index) {
        node.index = index;
        return node;
      });
  }

  /* Disjoint sets over node indexes. The smallest index always represents its set, so groups keep node order. */
  function disjointSets(size) {
    var parent = [];
    for (var i = 0; i < size; i++) parent.push(i);
    function find(index) {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    }
    function union(a, b) {
      var rootA = find(a);
      var rootB = find(b);
      if (rootA < rootB) parent[rootB] = rootA;
      else if (rootB < rootA) parent[rootA] = rootB;
    }
    return { find: find, union: union };
  }

  /* Puts every index that shares a key in one set. */
  function joinOnKeys(sets, indexes, keysOf) {
    var holder = Object.create(null);
    indexes.forEach(function (index) {
      keysOf(index).forEach(function (key) {
        if (holder[key] === undefined) holder[key] = index;
        else sets.union(holder[key], index);
      });
    });
  }

  function indexesOf(nodes) {
    return nodes.map(function (node) {
      return node.index;
    });
  }

  /* Each node's attached parents, by index. A reference to a missing id is already untraced. */
  function parentIndexes(nodes) {
    var byId = Object.create(null);
    nodes.forEach(function (node) {
      if (node.id && byId[node.id] === undefined) byId[node.id] = node.index;
    });
    return nodes.map(function (node) {
      return derivedFrom(node.source, "derives_from_internal")
        .map(function (ref) {
          return byId[ref];
        })
        .filter(function (index) {
          return index !== undefined;
        });
    });
  }

  /*
   * A node is traced when its own annotation is readable and every source it rests on is
   * traced. Iterative, so a long chain cannot overflow the stack; a loop reaches no origin,
   * so its members are not traced.
   */
  function traceUpward(nodes, parents) {
    var state = [];
    var traced = [];
    nodes.forEach(function (start) {
      if (state[start.index]) return;
      var path = [{ index: start.index, next: 0, ok: !start.untraced }];
      state[start.index] = 1;
      while (path.length) {
        var top = path[path.length - 1];
        var above = parents[top.index];
        if (top.next < above.length) {
          var parent = above[top.next++];
          if (state[parent] === 1) {
            top.ok = false;
          } else if (state[parent] === 2) {
            top.ok = top.ok && traced[parent];
          } else {
            state[parent] = 1;
            path.push({ index: parent, next: 0, ok: !nodes[parent].untraced });
          }
          continue;
        }
        path.pop();
        state[top.index] = 2;
        traced[top.index] = top.ok;
        if (path.length) path[path.length - 1].ok = path[path.length - 1].ok && top.ok;
      }
    });
    return traced;
  }

  /* Every node a qualifying source rests on, followed upward with a head-index queue. */
  function anchoredNodes(nodes, parents) {
    var anchored = [];
    var queue = [];
    nodes.forEach(function (node) {
      if (!node.qualifying) return;
      anchored[node.index] = true;
      queue.push(node.index);
    });
    for (var head = 0; head < queue.length; head++) {
      parents[queue[head]].forEach(function (parent) {
        if (anchored[parent]) return;
        anchored[parent] = true;
        queue.push(parent);
      });
    }
    return anchored;
  }

  /*
   * Two qualifying sources are one piece of evidence when they share an outlet (the same
   * publisher or website), an outside origin, or any source they rest on. Links are only
   * followed upward from evidence, so a roundup that cites two reports joins neither.
   */
  function evidenceGroups(nodes) {
    var parents = parentIndexes(nodes);
    var anchored = anchoredNodes(nodes, parents);
    var sets = disjointSets(nodes.length);
    joinOnKeys(sets, indexesOf(nodes), function (index) {
      var keys = [];
      var host = urlHost(nodes[index].source.url);
      if (nodes[index].publisher) keys.push("publisher:" + nodes[index].publisher);
      if (host) keys.push("host:" + host);
      return keys;
    });
    var upstream = indexesOf(nodes).filter(function (index) {
      return anchored[index];
    });
    joinOnKeys(sets, upstream, function (index) {
      return externalRootsOf(nodes[index].source);
    });
    upstream.forEach(function (index) {
      parents[index].forEach(function (parent) {
        sets.union(index, parent);
      });
    });

    var groups = [];
    var slot = Object.create(null);
    nodes.forEach(function (node) {
      var root = sets.find(node.index);
      if (slot[root] === undefined) {
        slot[root] = groups.length;
        groups.push([]);
      }
      groups[slot[root]].push(node);
    });
    return { groups: groups, traced: traceUpward(nodes, parents) };
  }

  function holdsQualifying(members) {
    return members.some(function (node) {
      return node.qualifying;
    });
  }

  function describeComponent(members, traced) {
    var roots = [];
    members.forEach(function (node) {
      Array.prototype.push.apply(roots, externalRootsOf(node.source));
    });
    return {
      sources: members.map(function (node) {
        return node.label;
      }),
      members: members.map(function (node) {
        return node.source;
      }),
      external_roots: distinct(roots).sort(),
      qualifying: holdsQualifying(members),
      // One untraced member could restate any other, whatever its own grade.
      untraced: members.some(function (node) {
        return !traced[node.index];
      })
    };
  }

  function provenanceVerdict(qualifyingCount, counted) {
    if (qualifyingCount === 0) return "NO_QUALIFYING_SOURCES";
    var untraced = counted.some(function (component) {
      return component.untraced;
    });
    if (untraced) return "INDETERMINATE";
    return counted.length >= 2 ? "INDEPENDENT_CONFIRMED" : "SINGLE_ROOT";
  }

  /* A publisher-less source cannot be shown to share a publisher, so each counts as its own. */
  function countDistinctPublishers(qualifying) {
    var named = qualifying
      .map(function (node) {
        return node.publisher;
      })
      .filter(Boolean);
    return distinct(named).length + (qualifying.length - named.length);
  }

  /*
   * The sources a reviewer must annotate before the record can leave INDETERMINATE: the
   * unreadable annotations, or, when there are none, the members of a loop.
   */
  function collectPending(groups, traced) {
    var pending = [];
    groups.filter(holdsQualifying).forEach(function (members) {
      var unreadable = members.filter(function (node) {
        return node.untraced;
      });
      var blocking = unreadable.length
        ? unreadable
        : members.filter(function (node) {
            return !traced[node.index];
          });
      blocking.forEach(function (node) {
        pending.push(node.source);
      });
    });
    return pending;
  }

  /*
   * Groups one record's sources into pieces of evidence. Every source is drawn, but only a
   * group holding a qualifying source is counted.
   */
  function sourceRoots(record) {
    var nodes = sourceNodes(record);
    var grouped = evidenceGroups(nodes);
    var components = grouped.groups.map(function (members) {
      return describeComponent(members, grouped.traced);
    });
    var counted = components.filter(function (component) {
      return component.qualifying;
    });
    var qualifying = nodes.filter(function (node) {
      return node.qualifying;
    });

    return {
      id: record && record.id !== undefined ? record.id : null,
      verdict: provenanceVerdict(qualifying.length, counted),
      component_count: counted.length,
      distinct_publisher_count: countDistinctPublishers(qualifying),
      qualifying_source_count: qualifying.length,
      annotated_qualifying_count: qualifying.filter(function (node) {
        return !node.untraced;
      }).length,
      missing_publisher_count: qualifying.filter(function (node) {
        return node.publisher === "";
      }).length,
      pending_sources: collectPending(grouped.groups, grouped.traced),
      components: components
    };
  }

  /*
   * Shadow metric over the records the published rule counts. It never changes which
   * records count: it says how many of them rest on more than one root of evidence.
   */
  function provenanceSummary(records) {
    var counted = (records || []).filter(isHeadlineEligible);
    var summary = {
      total: counted.length,
      verdicts: {},
      ids: {},
      qualifying_source_count: 0,
      annotated_qualifying_count: 0,
      pending_source_count: 0,
      missing_publisher_count: 0
    };
    PROVENANCE_VERDICTS.forEach(function (verdict) {
      summary.verdicts[verdict] = 0;
      summary.ids[verdict] = [];
    });
    counted.forEach(function (record) {
      var roots = sourceRoots(record);
      summary.verdicts[roots.verdict] += 1;
      summary.ids[roots.verdict].push(record.id);
      summary.qualifying_source_count += roots.qualifying_source_count;
      summary.annotated_qualifying_count += roots.annotated_qualifying_count;
      summary.pending_source_count += roots.pending_sources.length;
      summary.missing_publisher_count += roots.missing_publisher_count;
    });
    PROVENANCE_VERDICTS.forEach(function (verdict) {
      summary.ids[verdict].sort();
    });
    return summary;
  }

  // Feed filter criteria that compare one record field for exact equality.
  var FILTER_FIELDS = {
    status: "verification_status",
    grade: "evidence_grade",
    category: "category",
    sector: "sector"
  };

  // Free text is read from these fields only, so a search cannot match a hidden value.
  var TEXT_FIELDS = ["title", "organization", "summary"];

  /*
   * Narrows a list of records for the feed. Criteria are ANDed; a missing or empty
   * criterion matches everything, and a value no record carries matches nothing.
   * This only selects records. It computes no number and derive() never calls it, so
   * no filter a visitor applies can move a headline total.
   */
  function filterRecords(records, criteria) {
    var c = criteria || {};
    var text = String(c.text || "").trim().toLowerCase();
    return records.filter(function (record) {
      var fieldsMatch = Object.keys(FILTER_FIELDS).every(function (name) {
        return !c[name] || record[FILTER_FIELDS[name]] === c[name];
      });
      if (!fieldsMatch) return false;
      if (c.inHeadline && c.inHeadline !== "all") {
        var want = c.inHeadline === "headline" ? true : c.inHeadline === "excluded" ? false : null;
        if (want === null || isHeadlineEligible(record) !== want) return false;
      }
      if (!text) return true;
      // Joined on a newline so a search cannot match across the end of one field.
      var haystack = TEXT_FIELDS.map(function (f) {
        return String(record[f] || "");
      })
        .join("\n")
        .toLowerCase();
      return haystack.indexOf(text) !== -1;
    });
  }

  /*
   * The values each feed select offers: those present in the records, sorted, so no
   * choice can match nothing. Keyed by criterion name, as filterRecords() reads them.
   */
  function filterOptions(records) {
    var options = {};
    Object.keys(FILTER_FIELDS).forEach(function (name) {
      var seen = {};
      records.forEach(function (record) {
        var value = record[FILTER_FIELDS[name]];
        if (value) seen[value] = true;
      });
      options[name] = Object.keys(seen).sort();
    });
    return options;
  }

  return {
    HEADLINE_STATUSES: HEADLINE_STATUSES,
    HEADLINE_GRADES: HEADLINE_GRADES,
    AGENT_ROLES: AGENT_ROLES,
    AXES: AXES,
    isHeadlineEligible: isHeadlineEligible,
    exclusion: exclusion,
    occurrence: occurrence,
    isAgentCaused: isAgentCaused,
    isAuthGap: isAuthGap,
    isUnauthorizedClaim: isUnauthorizedClaim,
    geographySupported: geographySupported,
    daysBetween: daysBetween,
    daysSinceLatestDisclosure: daysSinceLatestDisclosure,
    confirmedMoney: confirmedMoney,
    estimatedMoney: estimatedMoney,
    groupByAxis: groupByAxis,
    averageDisclosureLag: averageDisclosureLag,
    comparePublishedSummary: comparePublishedSummary,
    canonicalJson: canonicalJson,
    contentChecksumText: contentChecksumText,
    vulnerabilityDefinition: vulnerabilityDefinition,
    filterRecords: filterRecords,
    filterOptions: filterOptions,
    derive: derive,
    RULE_SETS: RULE_SETS,
    sensitivityTable: sensitivityTable,
    PROVENANCE_KINDS: PROVENANCE_KINDS,
    PROVENANCE_VERDICTS: PROVENANCE_VERDICTS,
    verdictDefinition: verdictDefinition,
    isConfirmed: isConfirmed,
    RELIANCE_REASONS: RELIANCE_REASONS,
    relianceDecision: relianceDecision,
    EXTERNAL_ROOT_PREFIXES: EXTERNAL_ROOT_PREFIXES,
    EXTERNAL_ROOT_KEY: EXTERNAL_ROOT_KEY,
    SOURCE_ID: SOURCE_ID,
    normalizePublisher: normalizePublisher,
    sourceLinks: sourceLinks,
    sourceRoots: sourceRoots,
    provenanceSummary: provenanceSummary
  };
});
