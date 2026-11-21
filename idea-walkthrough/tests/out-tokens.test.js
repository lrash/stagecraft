#!/usr/bin/env node
// How many output tokens a request asks for.
//
// 2026-08-23: Reconcile could not complete. Four attempts across two different large models,
// every one `truncated` -- the model stopped inside its own <think> block and returned no
// answer. Cause was not the models: max_tokens was hardcoded 4000 at three call sites, the
// high floor reaches REASONING models that spend output tokens thinking, and Reconcile has the
// longest prompt in the pipeline. The day before, the same stage produced 479 characters --
// it escaped its reasoning block with nothing left to say, and "audited" nothing.
//   Run:  node tests/out-tokens.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const a = html.indexOf("const OUT_TOKENS_MIN"), b = html.indexOf("function stripThinking");
ok("located outTokens", a > 0 && b > a);
const T = new Function(html.slice(a, b) + "\nreturn outTokens;")();

// The floor: nothing regresses below what used to be hardcoded.
// The floor is the load-bearing number. Scoping Reconcile's input dropped the budget to the
// old 4000 floor and truncation returned immediately -- reasoning does not shrink with input.
ok("the floor is high enough for a reasoning model", T("hi") >= 12000, T("hi"));
ok("a SHORT prompt still gets the full floor (the 2026-08-23 regression)", T("x".repeat(5252)) >= 12000, T("x".repeat(5252)));
ok("an empty prompt is safe",                T("") >= 12000);
ok("null/undefined are safe",                T(null) >= 12000 && T(undefined) >= 12000);

// The actual failing case: Reconcile's real prompt size must get materially more room.
const RECONCILE = 14201, CRITIQUE = 11367;
ok("Reconcile's real prompt clears the old cap", T("x".repeat(RECONCILE)) > 4000, T("x".repeat(RECONCILE)));
ok("...and never less than Critique's",
   T("x".repeat(RECONCILE)) >= T("x".repeat(CRITIQUE)),
   {reconcile: T("x".repeat(RECONCILE)), critique: T("x".repeat(CRITIQUE))});

// It must be bounded: a runaway prompt cannot ask a provider for an absurd completion.
ok("a huge prompt is capped", T("x".repeat(500000)) === 24000, T("x".repeat(500000)));
ok("the cap is never exceeded", [1e3,1e4,1e5,1e6].every(n => T("x".repeat(n)) <= 24000));
ok("monotonic in prompt size",
   T("x".repeat(20000)) >= T("x".repeat(10000)) && T("x".repeat(10000)) >= T("x".repeat(5000)));

// And every provider must actually use it -- the defect was three hardcoded copies.
ok("no hardcoded max_tokens remains", !/max_tokens:\s*4000/.test(html));
const derived = (html.match(/max_tokens:\s*outTokens\(prompt\)/g) || []).length;
ok("every chat call site derives its budget (3)", derived === 3, derived);

console.log(fail ? `out-tokens.test.js: ${pass} passed, ${fail} FAILED`
                 : `out-tokens.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
