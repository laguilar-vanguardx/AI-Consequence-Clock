/*
 * Every path that decides what the clock counts must have a code owner.
 *
 *   node tests/codeowners.test.js
 *
 * GitHub only enforces code-owner review when branch protection asks for it; this test
 * makes sure the file it relies on keeps covering the right paths.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const PROTECTED = ["/data/", "/js/evidence.js", "/tests/", "/scripts/", "/.github/"];

/* The paths that have at least one owner, from CODEOWNERS text. */
function ownedPaths(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length > 1 && parts.slice(1).every((owner) => /^@[\w.-]+(\/[\w.-]+)?$/.test(owner)))
    .map((parts) => parts[0]);
}

const missing = (text) => PROTECTED.filter((p) => ownedPaths(text).indexOf(p) === -1);

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

const text = fs.readFileSync(path.join(__dirname, "..", ".github", "CODEOWNERS"), "utf8");
check("every protected path has an owner", missing(text), []);
check(
  "removing the data line is caught",
  missing(text.split("\n").filter((line) => !line.startsWith("/data/")).join("\n")),
  ["/data/"]
);
check("a path with no owner listed does not count", missing(text.replace("/tests/ @Jcapriola", "/tests/")), ["/tests/"]);
check("a commented-out line does not count", missing(text.replace("/scripts/", "# /scripts/")), ["/scripts/"]);

console.log("\n" + "-".repeat(64));
if (failures.length) {
  console.log("FAILED: " + failures.length + " assertion(s) failed, " + passed + " passed.");
  process.exit(1);
}
console.log("PASSED: " + passed + " assertions.");
