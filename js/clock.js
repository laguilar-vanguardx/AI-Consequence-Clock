/*
 * Rendering for the AI Consequence Clock preview.
 *
 * This file owns the DOM and nothing else. Every number it displays comes from
 * ClockEvidence.derive(), so the page cannot disagree with tests/derive.test.js.
 *
 * Two rules hold throughout:
 *   1. Nothing from data/incidents.json reaches the DOM unescaped. Contributed
 *      records are untrusted input, because CONTRIBUTING.md invites strangers to
 *      submit them.
 *   2. No handler is inline. All interaction is delegated from document, so a
 *      Content-Security-Policy without 'unsafe-inline' can be added later.
 */
(function () {
  "use strict";

  var E = window.ClockEvidence;
  var STATE = { dataset: null, records: [], summary: null, byId: {} };
  var lastFocus = null;

  function el(id) {
    return document.getElementById(id);
  }

  /* Escapes text for interpolation into markup, including attribute values. */
  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* Only http and https survive. A contributed javascript: URL must not render. */
  function safeUrl(value) {
    var raw = String(value || "").trim();
    if (/^https?:\/\//i.test(raw)) return esc(raw);
    return "";
  }

  function num(value) {
    if (value === null || value === undefined) return "—";
    return Number(value).toLocaleString("en-US");
  }

  function humanize(value) {
    return String(value || "").replace(/_/g, " ");
  }

  /*
   * The visitor's calendar date, not UTC's. toISOString() is UTC, so anyone far from
   * Greenwich saw the day counter run a day early or late for part of every day.
   */
  function today() {
    var d = new Date();
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  function formatMoney(byCurrency) {
    var keys = Object.keys(byCurrency);
    if (!keys.length) return "None in headline set";
    return keys
      .map(function (ccy) {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: ccy,
          maximumFractionDigits: 2
        }).format(byCurrency[ccy].amount);
      })
      .join(" · ");
  }

  /* ------------------------------------------------------------------ axes */

  /*
   * One axis table. Headline-eligible and feed-only are separate columns and are
   * never summed into a single figure, so no row can imply more verified
   * evidence than the sources support.
   */
  function renderAxis(axisName, containerId) {
    var groups = STATE.summary.axes[axisName];
    var axis = E.AXES[axisName];
    var container = el(containerId);
    if (!container) return;

    /*
     * A time axis gets bars because the shape over time is the point. The bar is scaled
     * to the largest headline count on this axis and is aria-hidden: it carries no
     * information the adjacent number does not already state, so a screen reader that
     * announced it would only repeat the cell.
     */
    var showBars = axis.order === "value";
    var peak = groups.reduce(function (max, g) {
      return Math.max(max, g.headline);
    }, 0);

    var rows = groups
      .map(function (g) {
        var reasons = [];
        if (g.exclusions.status_and_grade) reasons.push(g.exclusions.status_and_grade + " on both");
        if (g.exclusions.status) reasons.push(g.exclusions.status + " on review state");
        if (g.exclusions.grade) reasons.push(g.exclusions.grade + " on evidence grade");
        var reasonText = reasons.length ? reasons.join(", ") : "—";
        var definition =
          axisName === "vulnerability" ? E.vulnerabilityDefinition(g.value) : null;

        return (
          '<tr class="axis-row' +
          (g.supported ? "" : " axis-row-unsupported") +
          '">' +
          '<th scope="row">' +
          '<button type="button" class="axis-link" data-axis="' +
          esc(axisName) +
          '" data-value="' +
          esc(g.value) +
          '">' +
          esc(g.supported ? humanize(g.label) : g.label) +
          "</button>" +
          (definition ? '<span class="axis-def">' + esc(definition) + "</span>" : "") +
          (g.supported || axisName !== "country"
            ? ""
            : '<span class="axis-def">These records carry no region their attached sources establish. They are not resolved to a country.</span>') +
          (showBars && peak > 0
            ? '<span class="axis-bar" aria-hidden="true"><span style="width:' +
              Math.round((g.headline / peak) * 100) +
              '%"></span></span>'
            : "") +
          "</th>" +
          '<td class="n n-headline">' +
          num(g.headline) +
          "</td>" +
          '<td class="n n-excluded">' +
          num(g.excluded) +
          "</td>" +
          '<td class="reason">' +
          esc(reasonText) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    container.innerHTML =
      '<table class="axis-table">' +
      "<caption>" +
      esc(axis.title) +
      " · " +
      esc(axis.note) +
      "</caption>" +
      "<thead><tr>" +
      '<th scope="col">' +
      esc(axis.title) +
      "</th>" +
      '<th scope="col" class="n">In headline totals</th>' +
      '<th scope="col" class="n">Visible, not counted</th>' +
      '<th scope="col">Why not counted</th>' +
      "</tr></thead>" +
      "<tbody>" +
      (rows || '<tr><td colspan="4">No records.</td></tr>') +
      "</tbody>" +
      "</table>";
  }

  /* ----------------------------------------------------------------- cards */

  function renderRecordCard(record) {
    var ex = E.exclusion(record);
    var occurrence = E.occurrence(record);
    var sources = (record.sources || [])
      .map(function (s) {
        var url = safeUrl(s.url);
        var label = esc(s.publisher || s.title || "source");
        var grade = esc(s.evidence_grade || "");
        var inner = url
          ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>"
          : label + " (no usable link)";

        /*
         * The archive link is the reader's recourse when the live URL dies, so it is shown
         * rather than held in the data. It runs through the same URL check as any other
         * record field: archived_url arrives from the dataset and is not privileged.
         * A source with no archive says nothing here, because absence of a snapshot is not
         * a property of the source worth announcing on every row.
         */
        var archived = s.archived_url ? safeUrl(s.archived_url) : null;
        var archiveLink = archived
          ? ' <a class="cite-archive" href="' +
            archived +
            '" target="_blank" rel="noopener noreferrer">archived' +
            (s.archived_at ? " " + esc(s.archived_at) : "") +
            "</a>"
          : "";

        return (
          '<li class="cite">' +
          inner +
          (grade ? ' <span class="status">' + grade + "</span>" : "") +
          (s.publication_date ? ' <span class="cite-date">' + esc(s.publication_date) + "</span>" : "") +
          archiveLink +
          (s.title ? '<span class="cite-title">' + esc(s.title) + "</span>" : "") +
          "</li>"
        );
      })
      .join("");

    var changes = (record.change_log || [])
      .map(function (c) {
        var parts = [c.change, c.correction, c.correction_2, c.left_unchanged].filter(Boolean);
        return (
          "<li><b>Revision " +
          esc(c.revision) +
          " · " +
          esc(c.date) +
          "</b>" +
          parts
            .map(function (p) {
              return "<span>" + esc(p) + "</span>";
            })
            .join("") +
          "</li>"
        );
      })
      .join("");

    var confirmed = record.financial_loss_confirmed;

    return (
      '<article class="incident" id="record-' +
      esc(record.id) +
      '">' +
      "<h3>" +
      esc(record.title) +
      "</h3>" +
      '<p class="pills">' +
      '<span class="status">' +
      esc(record.verification_status) +
      "</span>" +
      '<span class="status">' +
      esc(record.evidence_grade) +
      "</span>" +
      '<span class="sev sev-' +
      esc(String(record.severity || "unknown").toLowerCase()) +
      '">' +
      esc(record.severity) +
      "</span>" +
      '<span class="occ occ-' +
      esc(occurrence) +
      '">' +
      (occurrence === "documented" ? "documented occurrence" : "demonstrated capability") +
      "</span>" +
      "</p>" +
      (ex
        ? '<p class="excluded-note"><b>Not in headline totals.</b> ' + esc(ex.detail) + "</p>"
        : '<p class="headline-note"><b>Counted in headline totals.</b> Review state and attached evidence both satisfy the headline rule.</p>') +
      "<p>" +
      esc(record.summary) +
      "</p>" +
      '<dl class="fields">' +
      field("Organization", record.organization) +
      field("Sector", humanize(record.sector)) +
      field("Region", E.geographySupported(record) ? record.country_region : "Not established by sources") +
      field("Vulnerability class", humanize(record.category)) +
      field("Consequence", humanize(record.consequence_class)) +
      field("Causal role", humanize(record.causal_role)) +
      field("Adversary", humanize(record.adversary)) +
      field("Authorization evidence", humanize(record.authorization_evidence)) +
      field("Unauthorized claim", humanize(record.unauthorized_claim)) +
      field("Reversibility", humanize(record.reversibility)) +
      field("Incident date", record.incident_date || "unknown") +
      field("Disclosure date", record.disclosure_date || "unknown") +
      field(
        "Disclosure lag",
        typeof record.disclosure_lag_days === "number" ? record.disclosure_lag_days + " days" : "unknown"
      ) +
      field(
        "Confirmed loss",
        confirmed ? confirmed.amount + " " + confirmed.currency : "None confirmed"
      ) +
      "</dl>" +
      (record.source_quality_basis
        ? '<p class="basis"><b>Why this grade.</b> ' + esc(record.source_quality_basis) + "</p>"
        : "") +
      '<p class="srclabel">Sources</p><ul class="cites">' +
      (sources || "<li>No sources attached.</li>") +
      "</ul>" +
      (window.ClockSourceGraph ? window.ClockSourceGraph.section(record, true) : "") +
      (changes ? '<p class="srclabel">Revision history</p><ul class="changes">' + changes + "</ul>" : "") +
      "</article>"
    );
  }

  function field(label, value) {
    return "<dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd>";
  }

  /* ---------------------------------------------------------------- dialog */

  function openSheet(title, subtitle, records) {
    // Moving between views inside an open sheet must not forget what opened it.
    if (!el("modal").classList.contains("open")) lastFocus = document.activeElement;
    el("sheet-title").textContent = title;
    el("sheet-sub").textContent = subtitle;
    el("sheet-body").innerHTML = records.length
      ? records.map(renderRecordCard).join("")
      : "<p>No records match this selection.</p>";
    var modal = el("modal");
    modal.classList.add("open");
    modal.removeAttribute("aria-hidden");
    document.body.classList.add("modal-open");
    modal.querySelector(".close").focus();
  }

  function closeSheet() {
    var modal = el("modal");
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    // Replace rather than push, so Back leaves the closed sheet behind. A record opened from a
    // filtered feed returns to that filtered feed's link.
    if (location.hash) history.replaceState(null, document.title, feedHash() || location.pathname + location.search);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* Closes the dialog without touching the hash or focus, for navigation that already moved. */
  function hideSheet() {
    var modal = el("modal");
    if (modal.classList.contains("open")) {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("modal-open");
    }
  }

  /*
   * The sheet is aria-modal, so Tab has to stay inside it. Without this a keyboard
   * user tabs into the page behind a dialog that still covers it.
   */
  function trapFocus(event) {
    var modal = el("modal");
    var focusable = Array.prototype.filter.call(
      modal.querySelectorAll("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])"),
      function (node) {
        return node.offsetParent !== null;
      }
    );
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    var active = document.activeElement;
    if (!modal.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ------------------------------------------------------------------ views */

  function showAxisValue(axisName, value) {
    var axis = E.AXES[axisName];
    var groups = STATE.summary.axes[axisName];
    var group = null;
    for (var i = 0; i < groups.length; i++) {
      if (String(groups[i].value) === String(value)) group = groups[i];
    }
    if (!group) return;
    var ids = group.headline_ids.concat(group.excluded_ids);
    var records = ids.map(function (id) {
      return STATE.byId[id];
    });
    openSheet(
      axis.title + " · " + (group.supported ? humanize(group.label) : group.label),
      group.headline +
        " of " +
        group.total +
        " records here enter headline totals. The rest stay visible with the rule that excluded them.",
      records
    );
  }

  function showSelection(key) {
    var records = STATE.records;
    var headline = records.filter(E.isHeadlineEligible);
    var map = {
      all: ["All seed records", "Every record in the dataset, counted or not.", records],
      headline: [
        "Headline-eligible records",
        "Review state and attached evidence both satisfy the published rule.",
        headline
      ],
      excluded: [
        "Visible but not counted",
        "These records are published with the rule that kept them out of headline totals.",
        records.filter(function (r) {
          return !E.isHeadlineEligible(r);
        })
      ],
      documented: [
        "Documented occurrences",
        "Headline-eligible records where the sources describe an event that happened.",
        headline.filter(function (r) {
          return E.occurrence(r) === "documented";
        })
      ],
      demonstrated: [
        "Demonstrated capabilities",
        "Headline-eligible records where the sources describe a vulnerability shown to be exploitable, not an event that occurred.",
        headline.filter(function (r) {
          return E.occurrence(r) === "demonstrated";
        })
      ],
      agent: [
        "Agent-caused",
        "causal_role is agent_initiated or agent_executed. This is a field, never a text match.",
        headline.filter(E.isAgentCaused)
      ],
      unauthorized: [
        "Unauthorized AI actions",
        "unauthorized_claim is explicitly true. Separate from the authorization-gap metric.",
        headline.filter(E.isUnauthorizedClaim)
      ],
      authgap: [
        "No documented execution-time authorization",
        "authorization_evidence is none_documented. Missing proof is not proven unauthorized action.",
        headline.filter(E.isAuthGap)
      ],
      money: [
        "Confirmed monetary loss",
        "Only amounts a source confirms. Estimates are never added to this total.",
        headline.filter(function (r) {
          return !!r.financial_loss_confirmed;
        })
      ]
    };
    var entry = map[key];
    if (!entry) return;
    openSheet(entry[0], entry[1], entry[2]);
  }

  function showRecord(id) {
    var record = STATE.byId[id];
    if (!record) return;
    openSheet("Record · " + id, "Deep link to a single record.", [record]);
  }

  /* --------------------------------------------------------------- routing */

  /*
   * Deep links live in the hash so a refresh or a pasted URL reopens the same
   * view. Three shapes: #/record/<id>, #/axis/<axis>/<value>, #/view/<key>.
   *
   * A fourth, #/feed?status=VERIFIED&text=..., carries the feed filters. It is read
   * before the hash is decoded, because each value is encoded on its own and a decoded
   * "&" or "=" inside a search term would split it. One hash holds one shape, so opening
   * a record replaces the filters and closing it puts them back.
   *
   * Each segment is encoded on the way out and decoded on the way in. A hand-edited
   * or truncated link with a stray "%" cannot be decoded; it opens the plain page
   * rather than throwing and leaving the visitor with nothing.
   */
  function applyHash() {
    if (location.hash.indexOf(FEED_ROUTE) === 0) {
      hideSheet();
      writeFilters(new URLSearchParams(location.hash.slice(FEED_ROUTE.length)));
      return;
    }
    var parts;
    try {
      parts = location.hash
        .replace(/^#/, "")
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
    } catch (e) {
      parts = [];
    }
    if (!parts.length) {
      if (el("modal").classList.contains("open")) closeSheet();
      writeFilters(new URLSearchParams());
      return;
    }
    if (parts[0] === "record" && parts[1]) showRecord(parts[1]);
    else if (parts[0] === "axis" && parts[1] && parts.length > 2)
      showAxisValue(parts[1], parts.slice(2).join("/"));
    else if (parts[0] === "view" && parts[1]) showSelection(parts[1]);
  }

  function setHash(segments) {
    var next = "#/" + segments.map(encodeURIComponent).join("/");
    if (location.hash === next) applyHash();
    else location.hash = next;
  }

  /* ---------------------------------------------------------------- render */

  function render(dataset) {
    var summary = E.derive(dataset, today());
    STATE.dataset = dataset;
    STATE.records = dataset.incidents || [];
    STATE.summary = summary;
    STATE.byId = {};
    STATE.records.forEach(function (r) {
      STATE.byId[r.id] = r;
    });

    el("updated").textContent =
      (dataset.generated_at || "unknown").replace("T", " ") +
      " · reviewed " +
      (dataset.last_evidence_review || "not recorded");

    el("kpi-headline").textContent = num(summary.headline_count);
    el("headline-count").textContent = num(summary.headline_count);
    el("record-count").textContent = num(summary.record_count);
    el("kpi-documented").textContent = num(summary.documented_occurrences);
    el("kpi-demonstrated").textContent = num(summary.demonstrated_capabilities);
    el("kpi-agent").textContent = num(summary.agent_caused);
    el("kpi-unauth").textContent = num(summary.unauthorized_actions);
    el("kpi-money").textContent = formatMoney(summary.confirmed_money);
    el("hero-value").textContent = num(summary.authorization_gap);
    el("kpi-human").textContent = num(summary.human_interventions);
    el("kpi-rollback").textContent = num(summary.rolled_back);
    el("kpi-irreversible").textContent = num(summary.irreversible);
    el("lag").textContent = summary.disclosure_lag_average === null ? "—" : num(summary.disclosure_lag_average);
    el("lag-n").textContent = num(summary.disclosure_lag_n);
    el("days-since").textContent = num(summary.days_since_latest_disclosure);
    el("geo-unsupported").textContent = num(summary.geography_unsupported);

    var latest = summary.latest_disclosure_record;
    el("days-since-note").textContent = latest
      ? "Latest disclosure in the dataset: " + latest.disclosure_date + " · " + latest.title
      : "No dated disclosures.";

    renderAxis("country", "axis-country");
    renderAxis("sector", "axis-sector");
    renderAxis("vulnerability", "axis-vulnerability");
    renderAxis("consequence", "axis-consequence");
    renderAxis("year", "axis-year");

    fillFilterOptions();
    renderFeed();

    attachProvenance(summary);
  }

  /* ------------------------------------------------------------------ feed */

  /*
   * The feed is the one place a visitor can narrow what they read. Selection happens in
   * ClockEvidence.filterRecords(), and summary is never recomputed from its result, so
   * a filter cannot move a headline total, a KPI, or an axis row.
   */
  var FILTER_NAMES = ["text", "status", "grade", "category", "sector", "inHeadline"];

  /* Options come from ClockEvidence.filterOptions(), so no choice can be empty by design. */
  function fillFilterOptions() {
    var form = el("feed-filters");
    var options = E.filterOptions(STATE.records);
    Object.keys(options).forEach(function (name) {
      // Review state and grade read as the uppercase codes the pills show.
      var raw = name === "status" || name === "grade";
      form.elements[name].innerHTML =
        '<option value="">Any</option>' +
        options[name]
          .map(function (value) {
            return '<option value="' + esc(value) + '">' + esc(raw ? value : humanize(value)) + "</option>";
          })
          .join("");
    });
  }

  function readFilters() {
    var form = el("feed-filters");
    var criteria = {};
    FILTER_NAMES.forEach(function (name) {
      var value = String(form.elements[name].value || "").trim();
      // "all" is the headline select's no-filter value; in the search box it is a real term.
      if (value && !(name === "inHeadline" && value === "all")) criteria[name] = value;
    });
    return criteria;
  }

  /*
   * Sets the controls from a link. A value the data no longer carries falls back to
   * "Any" rather than leaving a blank select, and the link is then rewritten to what
   * the controls actually show, so a stale shared link cannot claim a filter that is
   * not applied.
   */
  function writeFilters(params) {
    var form = el("feed-filters");
    FILTER_NAMES.forEach(function (name) {
      var control = form.elements[name];
      control.value = params.get(name) || (name === "inHeadline" ? "all" : "");
      if (control.tagName === "SELECT" && control.selectedIndex === -1) control.selectedIndex = 0;
    });
    renderFeed();
    if (location.hash.indexOf(FEED_ROUTE) === 0) syncFeedHash();
  }

  function clearFilters() {
    writeFilters(new URLSearchParams());
  }

  var FEED_ROUTE = "#/feed?";

  /* Each value is encoded by URLSearchParams. An unfiltered feed has no hash at all. */
  function feedHash() {
    var criteria = readFilters();
    var params = new URLSearchParams();
    FILTER_NAMES.forEach(function (name) {
      if (criteria[name]) params.set(name, criteria[name]);
    });
    var query = params.toString();
    return query ? FEED_ROUTE + query : "";
  }

  /*
   * Replaced rather than pushed, so typing a search does not leave one history entry per
   * keystroke. Only an empty or feed hash is replaced: a record, axis, or view link is
   * never overwritten by a filter change.
   */
  function syncFeedHash() {
    if (location.hash && location.hash.indexOf(FEED_ROUTE) !== 0) return;
    history.replaceState("", document.title, feedHash() || location.pathname + location.search);
  }

  function renderFeed() {
    if (!STATE.summary) return;
    var criteria = readFilters();
    var shown = E.filterRecords(STATE.records, criteria);
    var filtered = Object.keys(criteria).length > 0;

    // The denominator is the derived record count, the same one the headline card shows.
    el("feed-count").textContent = filtered
      ? "Showing " + num(shown.length) + " of " + num(STATE.summary.record_count) +
        " records. Filters narrow this list only; the totals above are unchanged."
      : "Showing all " + num(STATE.summary.record_count) + " records.";

    if (!shown.length) {
      el("feed").innerHTML =
        '<p class="feed-empty">No records match these filters. ' +
        '<button type="button" class="inline-link" data-clear-filters>Clear filters</button></p>';
      return;
    }

    var feed = shown
      .sort(function (a, b) {
        return Date.parse(b.disclosure_date) - Date.parse(a.disclosure_date);
      })
      .map(function (r) {
        var ex = E.exclusion(r);
        return (
          '<button type="button" class="feed-row" data-record="' +
          esc(r.id) +
          '">' +
          '<span class="when">' +
          esc(r.disclosure_date) +
          "</span>" +
          '<span class="what">' +
          esc(r.title) +
          "</span>" +
          '<span class="status">' +
          esc(r.verification_status) +
          "</span>" +
          '<span class="status">' +
          esc(r.evidence_grade) +
          "</span>" +
          '<span class="tag ' +
          (ex ? "tag-out" : "tag-in") +
          '">' +
          (ex ? "not counted · " + esc(ex.code.replace(/_/g, " ")) : "counted") +
          "</span>" +
          "</button>"
        );
      })
      .join("");
    el("feed").innerHTML = feed;
  }

  async function sha256Hex(text) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.prototype.map
      .call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("");
  }

  /* Same two steps as scripts/content-digest.js: one hash per record, then a root hash. */
  async function contentDigest(records) {
    var lines = await Promise.all(
      records.map(async function (record) {
        return { id: record.id, hash: await sha256Hex(E.canonicalJson(record)) };
      })
    );
    return sha256Hex(E.contentChecksumText(lines));
  }

  async function attachProvenance(summary) {
    var ids = STATE.records
      .map(function (r) {
        return r.id;
      })
      .sort()
      .join(",");
    var digest = "unavailable";
    var content = null;
    try {
      digest = await sha256Hex(ids);
      content = await contentDigest(STATE.records);
    } catch (e) {
      digest = "unavailable in this context";
    }
    var published = null;
    try {
      published = await fetch("./data/summary.json").then(function (r) {
        return r.json();
      });
    } catch (e) {
      published = null;
    }
    var provenance = E.comparePublishedSummary(summary, published, { idDigest: digest, contentDigest: content });
    var digestLabel = /^[0-9a-f]{64}$/i.test(String(digest || "")) ? digest.slice(0, 16) + "…" : "unavailable";

    /*
     * Built from the dataset rather than hardcoded, so it cannot drift from the version it
     * describes. The access date is today's, because a preview dataset changes and a
     * citation without one cannot be checked against the version it was read from.
     */
    var citeEl = el("cite-block");
    if (citeEl) {
      citeEl.textContent =
        "AI Blockchain Ventures LLC / AI Modularity. AI Consequence Clock dataset, " +
        "methodology version " +
        summary.methodology_version +
        ", evidence layer " +
        (STATE.dataset.evidence_layer_version || "n/a") +
        ", dataset status " +
        (STATE.dataset.dataset_status || "n/a") +
        ". " +
        summary.record_count +
        " records, " +
        summary.headline_count +
        " in headline totals. Record id digest sha256 " +
        digestLabel.replace("…", "") +
        ". Accessed " +
        new Date().toISOString().slice(0, 10) +
        ".";
    }

    el("repro").textContent =
      "methodology " +
      summary.methodology_version +
      " · evidence layer " +
      (STATE.dataset.evidence_layer_version || "n/a") +
      " · headline " +
      summary.headline_count +
      " of " +
      summary.record_count +
      " · id sha256 " +
      digestLabel +
      " · " +
      provenance.label;
  }

  /* --------------------------------------------------------------- events */

  document.addEventListener("click", function (event) {
    var axisLink = event.target.closest("[data-axis]");
    if (axisLink) {
      setHash(["axis", axisLink.dataset.axis, axisLink.dataset.value]);
      return;
    }
    var viewLink = event.target.closest("[data-view]");
    if (viewLink) {
      setHash(["view", viewLink.dataset.view]);
      return;
    }
    var recordLink = event.target.closest("[data-record]");
    if (recordLink) {
      setHash(["record", recordLink.dataset.record]);
      return;
    }
    var clear = event.target.closest("[data-clear-filters]");
    if (clear) {
      // The empty-state button is removed by the re-render, so focus moves to the bar's.
      var fromEmptyState = !!clear.closest("#feed");
      clearFilters();
      if (fromEmptyState) el("feed-clear").focus();
      return;
    }
    if (event.target.closest(".close") || event.target.id === "modal") closeSheet();
  });

  // Select changes and typing both fire input, so the feed narrows as the visitor works.
  document.addEventListener("input", function (event) {
    if (!event.target.closest("#feed-filters")) return;
    renderFeed();
    syncFeedHash();
  });

  // Enter in the search box would otherwise submit the form and reload the page.
  document.addEventListener("submit", function (event) {
    if (event.target.id === "feed-filters") event.preventDefault();
  });

  document.addEventListener("keydown", function (event) {
    if (!el("modal").classList.contains("open")) return;
    if (event.key === "Escape") closeSheet();
    else if (event.key === "Tab") trapFocus(event);
  });

  window.addEventListener("hashchange", applyHash);

  fetch("./data/incidents.json")
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (dataset) {
      render(dataset);
      applyHash();
      // A shared filter link is about the feed, so open the page where the feed is.
      if (location.hash.indexOf(FEED_ROUTE) === 0) el("feed-filters").closest(".card").scrollIntoView();
    })
    .catch(function (err) {
      el("updated").textContent = "failed to load seed data";
      el("load-error").hidden = false;
      console.error("Could not load data/incidents.json.", err);
    });
})();
