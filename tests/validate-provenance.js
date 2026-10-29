/*
 * Validation for the optional provenance annotation on a source.
 *
 * A source with no annotation is UNKNOWN and is not checked here. One that declares
 * provenance is making a claim, so the claim must be well formed and must carry its own
 * proof: a short quote and an archived snapshot of the source, one per claim. Outside
 * origins must be registered in data/external-roots.json. The validator proves the shape
 * and the citation exist; whether a quote shows what it is cited for stays a human
 * judgement.
 */

var path = require("path");
var S = require(path.join(__dirname, "schema.js"));
var E = require(path.join(__dirname, "..", "js", "evidence.js"));

var ORIGINAL_BASES = ["ISSUED_DECISION", "OWN_RESEARCH", "ASSIGNING_AUTHORITY", "OWN_REPORTING"];
var PROVENANCE_KEYS = ["kind", "derives_from_internal", "derives_from_external", "note", "original_basis", "evidence"];
var EVIDENCE_KEYS = ["supports", "quote", "snapshot_url"];
var SUPPORTS_ORIGINAL = "original";
var QUOTE_MIN = 20;
var QUOTE_MAX = 300;
var SNAPSHOT = /^https:\/\/web\.archive\.org\/web\/(\d{14})(?:[a-z_]*)\/(.+)$/;
var KEY_FORMATS = { cve: /^cve:cve-\d{4}-\d{4,}$/ };

/*
 * The Wayback Machine stores a URL as it was captured, often http:// or with a trailing
 * slash, so the snapshot and the source are compared after removing those differences.
 */
function normalizeUrl(value) {
  var match = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]*)([^#]*)/i.exec(String(value || "").trim());
  if (!match) return "";
  var host = match[1]
    .replace(/^.*@/, "")
    .replace(/:(80|443)$/, "")
    .toLowerCase()
    .replace(/^www\./, "");
  var rest = match[2].replace(/\/+$/, "").replace(/\/(\?)/, "$1");
  return host + rest;
}

function isPlainList(value) {
  return (
    Array.isArray(value) &&
    value.every(function (item) {
      return typeof item === "string";
    })
  );
}

/* Builds the checks for one dataset. `fail(id, message)` records a problem. */
function createChecker(fail, registry) {
  var roots = (registry && registry.roots) || {};
  var used = Object.create(null);

  function stringListOrFail(value, where, id) {
    if (!isPlainList(value)) fail(id, where + " must be an array of strings");
    return isPlainList(value) ? value : [];
  }

  function collectSourceIds(record, id) {
    var sourceIds = Object.create(null);
    record.sources.forEach(function (source, si) {
      if (!S.isPlainObject(source) || source.id === undefined) return;
      var where = "sources[" + si + "]";
      if (typeof source.id !== "string" || !E.SOURCE_ID.test(source.id)) {
        fail(id, where + ".id must be a lowercase slug of letters, digits and hyphens");
      } else if (sourceIds[source.id]) {
        fail(id, where + '.id "' + source.id + '" is a duplicate source id within the record');
      } else {
        sourceIds[source.id] = true;
      }
    });
    return sourceIds;
  }

  function checkShape(source, sourceWhere, id) {
    var where = sourceWhere + ".provenance";
    var p = source.provenance;
    if (!S.isPlainObject(p)) {
      fail(id, where + " must be an object with kind, derives_from_internal, derives_from_external and evidence");
      return false;
    }
    Object.keys(p).forEach(function (key) {
      if (PROVENANCE_KEYS.indexOf(key) === -1) fail(id, where + ' has an unknown field "' + key + '"');
    });
    if (source.id === undefined) {
      fail(id, sourceWhere + ".id is required on a source that declares provenance");
    }
    if (E.PROVENANCE_KINDS.indexOf(p.kind) === -1) {
      fail(id, where + '.kind has unknown value "' + p.kind + '". Allowed: ' + E.PROVENANCE_KINDS.join(", "));
    }
    if (p.note !== undefined && p.note !== null && typeof p.note !== "string") {
      fail(id, where + ".note must be a string");
    }
    return true;
  }

  function checkReferenceCount(kind, count, where, id) {
    if ((kind === "ORIGINAL" || kind === "UNKNOWN") && count > 0) {
      fail(id, where + " is " + kind + " and must not list anything it derives from");
    }
    if (kind === "DERIVED" && count === 0) {
      fail(id, where + " is DERIVED and must name at least one source or external root");
    }
  }

  function checkOriginalBasis(p, where, id) {
    if (p.kind === "ORIGINAL" && ORIGINAL_BASES.indexOf(p.original_basis) === -1) {
      fail(id, where + ".original_basis must be one of " + ORIGINAL_BASES.join(", "));
    }
    if (p.kind !== "ORIGINAL" && p.original_basis !== undefined) {
      fail(id, where + ".original_basis is only for ORIGINAL");
    }
  }

  /* An outside origin must be registered once, with its own citation, in the expected format. */
  function checkExternalKeys(keys, where, id) {
    keys.forEach(function (key) {
      var lower = key.toLowerCase();
      var prefix = lower.split(":")[0];
      if (!E.EXTERNAL_ROOT_KEY.test(key) || (KEY_FORMATS[prefix] && !KEY_FORMATS[prefix].test(lower))) {
        fail(
          id,
          where + '.derives_from_external key "' + key + '" must look like <prefix>:<slug> with prefix in ' +
            E.EXTERNAL_ROOT_PREFIXES.join(", ") + (KEY_FORMATS[prefix] ? ", and a cve key like cve:cve-2024-0001" : "")
        );
      } else if (!roots[lower]) {
        fail(id, where + '.derives_from_external key "' + key + '" is not registered in data/external-roots.json');
      } else {
        used[lower] = true;
      }
    });
  }

  function resolvedInternalRefs(refs, source, sourceIds, where, id) {
    var resolved = [];
    refs.forEach(function (ref) {
      if (ref === source.id) {
        fail(id, where + ".derives_from_internal must not reference the source itself");
      } else if (!sourceIds[ref]) {
        fail(id, where + '.derives_from_internal names "' + ref + '", which is not a source id on this record');
      } else {
        resolved.push(ref);
      }
    });
    return resolved;
  }

  function checkEvidenceEntry(entry, source, where, id) {
    if (!S.isPlainObject(entry)) {
      fail(id, where + " must be an object with supports, quote and snapshot_url");
      return null;
    }
    Object.keys(entry).forEach(function (key) {
      if (EVIDENCE_KEYS.indexOf(key) === -1) fail(id, where + ' has an unknown field "' + key + '"');
    });
    var quote = typeof entry.quote === "string" ? entry.quote.trim() : "";
    if (quote.length < QUOTE_MIN || quote.length > QUOTE_MAX) {
      fail(id, where + ".quote must be " + QUOTE_MIN + "-" + QUOTE_MAX + " characters copied from the source");
    }
    var snapshot = SNAPSHOT.exec(String(entry.snapshot_url || ""));
    if (!snapshot) {
      fail(id, where + ".snapshot_url must be a https://web.archive.org/web/<14-digit timestamp>/<url> capture");
    } else if (normalizeUrl(snapshot[2]) !== normalizeUrl(source.url)) {
      fail(id, where + ".snapshot_url must be a capture of this source's own url");
    }
    return typeof entry.supports === "string" ? entry.supports.toLowerCase() : null;
  }

  /* One evidence entry per claim: "original" for ORIGINAL, and each reference for DERIVED. */
  function checkEvidence(p, source, internal, external, where, id) {
    var evidence = p.evidence;
    if (p.kind === "UNKNOWN") {
      if (evidence !== undefined) fail(id, where + ".evidence is only for ORIGINAL and DERIVED");
      return;
    }
    if (!Array.isArray(evidence) || evidence.length === 0) {
      fail(id, where + ".evidence must list a quote and an archived snapshot for each claim");
      return;
    }
    var claims =
      p.kind === "ORIGINAL"
        ? [SUPPORTS_ORIGINAL]
        : internal.concat(external).map(function (ref) {
            return ref.toLowerCase();
          });
    var supported = Object.create(null);
    evidence.forEach(function (entry, ei) {
      var supports = checkEvidenceEntry(entry, source, where + ".evidence[" + ei + "]", id);
      if (supports === null) return;
      if (claims.indexOf(supports) === -1) {
        fail(id, where + ".evidence[" + ei + "].supports \"" + entry.supports + '" is not a claim of this source');
      }
      supported[supports] = true;
    });
    claims.forEach(function (claim) {
      if (!supported[claim]) fail(id, where + '.evidence has no entry supporting "' + claim + '"');
    });
  }

  function checkDeclaration(source, sourceWhere, sourceIds, id) {
    if (!checkShape(source, sourceWhere, id)) return [];
    var where = sourceWhere + ".provenance";
    var p = source.provenance;
    var internal = stringListOrFail(p.derives_from_internal, where + ".derives_from_internal", id);
    var external = stringListOrFail(p.derives_from_external, where + ".derives_from_external", id);
    checkReferenceCount(p.kind, internal.length + external.length, where, id);
    checkOriginalBasis(p, where, id);
    checkExternalKeys(external, where, id);
    if (E.PROVENANCE_KINDS.indexOf(p.kind) !== -1) checkEvidence(p, source, internal, external, where, id);
    return resolvedInternalRefs(internal, source, sourceIds, where, id);
  }

  function checkRecord(record, id) {
    var sourceIds = collectSourceIds(record, id);
    var internalEdges = Object.create(null);
    record.sources.forEach(function (source, si) {
      if (!S.isPlainObject(source) || source.provenance === undefined) return;
      var refs = checkDeclaration(source, "sources[" + si + "]", sourceIds, id);
      if (typeof source.id === "string") internalEdges[source.id] = refs;
    });
    var unresolved = unresolvedDerivations(internalEdges);
    if (unresolved.length) {
      fail(id, "provenance has a derivation cycle; sources on it or cited from it: " + unresolved.join(", "));
    }
  }

  return {
    checkRecord: checkRecord,
    unusedRoots: function () {
      return Object.keys(roots)
        .filter(function (key) {
          return !used[key];
        })
        .sort();
    }
  };
}

/* Kahn's algorithm. What cannot be ordered is on a derivation loop or cited from one. */
function unresolvedDerivations(edges) {
  var nodes = Object.keys(edges).sort();
  var indegree = Object.create(null);
  nodes.forEach(function (from) {
    edges[from].forEach(function (to) {
      if (edges[to]) indegree[to] = (indegree[to] || 0) + 1;
    });
  });
  var ready = nodes.filter(function (node) {
    return !indegree[node];
  });
  for (var head = 0; head < ready.length; head++) {
    edges[ready[head]].forEach(function (to) {
      if (!edges[to]) return;
      indegree[to] -= 1;
      if (indegree[to] === 0) ready.push(to);
    });
  }
  return nodes.filter(function (node) {
    return indegree[node] > 0;
  });
}

/* Digits with leading zeros removed, so "cve-2026-1" and "cve-2026-01" share a group. */
function nearDuplicateGroup(key) {
  return key.replace(/\d+/g, function (digits) {
    return String(Number(digits));
  });
}

/*
 * Checks the registry itself. Returns problems and warnings. Near-duplicates are found by
 * grouping, not by comparing every pair, so it stays linear as the registry grows.
 */
function checkRegistry(registry) {
  var problems = [];
  var warnings = [];
  if (!S.isPlainObject(registry) || !S.isPlainObject(registry.roots)) {
    return { problems: ['data/external-roots.json must be an object with a "roots" object'], warnings: warnings };
  }
  var groups = Object.create(null);
  Object.keys(registry.roots)
    .sort()
    .forEach(function (key) {
      var entry = registry.roots[key];
      var prefix = key.split(":")[0];
      var wellFormed = E.EXTERNAL_ROOT_KEY.test(key) && !(KEY_FORMATS[prefix] && !KEY_FORMATS[prefix].test(key));
      if (key !== key.toLowerCase() || !wellFormed) {
        problems.push(
          'registry key "' + key + '" must be lowercase <prefix>:<slug>, and a cve key like cve:cve-2024-0001'
        );
      }
      if (!S.isPlainObject(entry) || typeof entry.title !== "string" || !entry.title.trim()) {
        problems.push('registry key "' + key + '" needs a title');
      }
      if (!S.isPlainObject(entry) || !/^https?:\/\//i.test(String(entry.url || ""))) {
        problems.push('registry key "' + key + '" needs an http or https url, so the origin itself can be checked');
      }
      var group = nearDuplicateGroup(key);
      if (groups[group]) {
        warnings.push('registry keys "' + groups[group] + '" and "' + key + '" look like the same origin');
      } else {
        groups[group] = key;
      }
    });
  return { problems: problems, warnings: warnings };
}

module.exports = {
  createChecker: createChecker,
  checkRegistry: checkRegistry,
  normalizeUrl: normalizeUrl,
  ORIGINAL_BASES: ORIGINAL_BASES,
  QUOTE_MIN: QUOTE_MIN,
  QUOTE_MAX: QUOTE_MAX
};
