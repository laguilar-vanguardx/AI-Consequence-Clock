/*
 * Node side of the published checksums. js/evidence.js builds the text; this file hashes it,
 * so the evidence module stays free of Node's crypto and the page can use crypto.subtle.
 */
"use strict";

const crypto = require("crypto");
const path = require("path");
const E = require(path.join(__dirname, "..", "js", "evidence.js"));

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/* The original checksum: the sorted incident ids, comma-joined. */
function idDigest(records) {
  return sha256((records || []).map((record) => record.id).sort().join(","));
}

function contentDigest(records) {
  const lines = (records || []).map((record) => ({ id: record.id, hash: sha256(E.canonicalJson(record)) }));
  return sha256(E.contentChecksumText(lines));
}

module.exports = { idDigest, contentDigest, sha256 };
