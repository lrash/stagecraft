#!/usr/bin/env node
// The exported document's title.
//
// 2026-08-22: two runs (v1 and v3) of the same idea exported as
//   "# Allowing access to free AI sources for user's that can't afford subscriptions or"
// A fixed .slice(0,80) landed mid-phrase and dropped "local computer". The title did not just
// get shorter — it said something different, and nothing marked it as truncated. A reader, and
// anyone grading the run, sees a title that misstates the idea.
//   Run:  node tests/title.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const a = html.indexOf("function titleOf(idea, max){"), b = html.indexOf("function exportName(){");
if (a < 0 || b < 0 || b < a) { console.log("FAIL  could not locate titleOf in index.html"); process.exit(1); }
const T = new Function(html.slice(a, b) + "\nreturn titleOf;")();

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const REAL = "Allowing access to free AI sources for user's that can't afford subscriptions or local computer.";

// --- the regression itself -------------------------------------------------------------
ok("the real v3 title no longer ends mid-phrase at 'or'", !/ or$/.test(T(REAL)), T(REAL));
ok("it is marked as truncated",                            T(REAL).endsWith("…"), T(REAL));
// The real property: strip the ellipsis and what remains must be a prefix of the original
// that ends exactly where a word ends — i.e. the next character in the source is a space.
const body = T(REAL).replace(/…$/, "");
ok("the kept text is a prefix of the original",  REAL.startsWith(body), body);
ok("it ends on a word boundary, not mid-word",   REAL[body.length] === " " || REAL.length === body.length, JSON.stringify(REAL[body.length]));
ok("it stays within the limit",                            T(REAL).length <= 80, T(REAL).length);

// --- boundaries ------------------------------------------------------------------------
ok("a short title is untouched",        T("A small idea") === "A small idea");
ok("exactly 80 chars is untouched",     T("x".repeat(80)) === "x".repeat(80), T("x".repeat(80)).length);
ok("81 chars is truncated",             T("y".repeat(81)).endsWith("…"));
ok("no ellipsis when not truncated",    T("A small idea").indexOf("…") === -1);

// A single token longer than the limit has no word boundary to fall back to.
const LONG = "z".repeat(200);
ok("one huge word still hard-cuts",     T(LONG).endsWith("…") && T(LONG).length <= 80, T(LONG).length);

// Backing up to the last space must not throw away most of the title.
const LATE = "z".repeat(70) + " tail text that runs on well past the limit";
ok("a late-only space does not gut the title", T(LATE).length > 40, T(LATE));

// --- shape -----------------------------------------------------------------------------
ok("only the first line is used",       T("First line here\nSecond line") === "First line here", T("First line here\nSecond line"));
ok("leading/trailing space is trimmed", T("   padded   ") === "padded", T("   padded   "));
ok("dangling punctuation is stripped before the ellipsis",
   !/[ ,;:.\-]…$/.test(T("word ".repeat(30))), T("word ".repeat(30)));
ok("empty input is safe",               T("") === "");
ok("null input is safe",                T(null) === "");
ok("undefined input is safe",           T(undefined) === "");
ok("a custom limit is honoured",        T("one two three four five", 10).length <= 10, T("one two three four five", 10));

console.log(fail ? `title.test.js: ${pass} passed, ${fail} FAILED` : `title.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
