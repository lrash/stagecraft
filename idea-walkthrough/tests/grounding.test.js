#!/usr/bin/env node
// The grounding check: which claims name something the source never mentioned.
//
// Measured, not asserted by taste. The fixture is Reconcile's OWN verdicts from the
// 2026-08-23 run — 8 items it called INVENTED, 7 it called grounded — so the check is scored
// against a real labelling produced by the expensive path it is meant to run ahead of.
//
// The first design scored general vocabulary overlap: invented averaged 0.17, grounded 0.18.
// Indistinguishable at every threshold, because a correct inference stated in fresh words
// looks exactly like an invention. That design was measured and discarded, not tuned.
//   Run:  node tests/grounding.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const L = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures-reconcile-2026-08-23.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const a = html.indexOf("const GROUND_STOP"), b = html.indexOf("const DIVERGE_MIN_WORDS");
ok("located the grounding check", a > 0 && b > a);
const M = new Function("S", html.slice(a, b) + "\nreturn {groundingCheck, sourceText, newNames};")
                      ({ idea: L.idea, outputs: { capture: L.capture } });
const src = M.sourceText();

// --- discrimination, on the real labels ---
const inv = M.groundingCheck(L.invented.join("\n"), src).items.length;
const sur = M.groundingCheck(L.survives.join("\n"), src).items.length;
ok("flags most items Reconcile called INVENTED", inv >= 6, {flagged: inv, of: L.invented.length});
ok("flags few items Reconcile called grounded",  sur <= 2, {flagged: sur, of: L.survives.length});
ok("and separates them",                         inv > sur * 2, {inv, sur});

// --- it must name WHAT it found, or it is not actionable ---
const one = M.groundingCheck(L.invented.join("\n"), src).items[0];
ok("each item names the unfamiliar entities", Array.isArray(one.names) && one.names.length > 0, one && one.names);
ok("and carries the line itself",             typeof one.line === "string" && one.line.length > 10);

// --- guards ---
ok("a claim using only source vocabulary is not flagged",
   M.groundingCheck("The engine must run a daily ingest of CVE data.", src).items.length === 0);
ok("headings are skipped",           M.groundingCheck("## Deepen", src).items.length === 0);
ok("empty input is safe",            M.groundingCheck("", src).items.length === 0);
ok("refuses to judge against a stub contract",
   M.groundingCheck("Docker and Kubernetes", "tiny").ready === false);
ok("the stop list keeps stage names out",
   M.newNames("Critique says Capture disagrees with Reconcile", src).length === 0,
   M.newNames("Critique says Capture disagrees with Reconcile", src));
ok("a genuinely new product name IS caught",
   M.newNames("Store results in PostgreSQL via Kubernetes", src).sort().join(",") === "Kubernetes,PostgreSQL",
   M.newNames("Store results in PostgreSQL via Kubernetes", src));

// --- and it must never be presented as a verdict ---
ok("the source disclaims it as a finding", /never a finding/.test(html));

// --- 2026-11-17: headings are not names (garage run: 12 of 12 rows were heading words) --------
ok("a bold label before a colon is a heading", M.newNames("Most Important Trade-Off**: Balancing scope with depth", "zzz").length === 0);
ok("a severity tag plus label before a dash is a heading", M.newNames("High** Image Handling — assuming photos are clear", "zzz").length === 0);
ok("a name by shape is still checked inside a heading", M.newNames("High** GDPR fines — stored photos", "zzz").includes("GDPR"));
ok("a long opening is a sentence, so its names are checked",
   M.newNames("We could ship it through Docker on the old box today — cheap", "zzz").includes("Docker"));
ok("capitalised severity labels are not names", M.newNames("[SEVERE] Interview process — fails", "zzz").length === 0
   && M.newNames("x — [HIGH] the photos — y", "zzz").length === 0);
ok("the word after a severity tag starts the line", M.newNames("[Critical] Core assumption that photos are enough — fails", "zzz").length === 0
   && M.newNames("[High] Docker everywhere — fails", "zzz").includes("Docker") === false);
console.log(fail ? `grounding.test.js: ${pass} passed, ${fail} FAILED`
                 : `grounding.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
