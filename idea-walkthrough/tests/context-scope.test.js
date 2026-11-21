#!/usr/bin/env node
// What each stage is shown, and whether it is told what it is NOT shown.
//
// 2026-08-23: Reconcile failed six attempts across three models, every one `truncated`. Its
// job is to hold the result against the CONTRACT, but it was handed the entire run -- Deepen
// alone was 12,210 of 19,252 characters, 63% of the input, for a question about two other
// stages. One attempt spent 378 seconds reasoning and never emerged.
//
// A stage may now declare `needs`. What is withheld MUST be named: a stage that silently sees
// less makes "no discrepancies found" ambiguous between "I checked" and "I was never shown
// it", which is the precise failure this app exists to prevent.
//   Run:  node tests/context-scope.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const _da = html.indexOf("function demoteHeadings(s){"), _db = html.indexOf("function exportName(){");
const DEMOTE_SRC = html.slice(_da, _db);

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const a = html.indexOf("const contextSoFar = (stage) => {");
const b = html.indexOf("/* ---------- rendering");
ok("located contextSoFar", a > 0 && b > a);

const STAGES = [
  { id:"capture",   name:"Capture",   status:"CONTRACT" },
  { id:"diverge",   name:"Diverge",   status:"PROPOSALS" },
  { id:"structure", name:"Structure", status:"ORDERING" },
  { id:"deepen",    name:"Deepen",    status:"ANALYSIS" },
  { id:"critique",  name:"Critique",  status:"OBJECTIONS" },
  { id:"reconcile", name:"Reconcile", status:"AUDIT", needs:["capture","critique"] },
];
const S = { stage: 5, outputs: Object.fromEntries(STAGES.slice(0,5).map(s => [s.id, s.id.toUpperCase()+"-BODY"])) };
const ctx = new Function("STAGES","S", DEMOTE_SRC + html.slice(a,b) + "\nreturn contextSoFar;")(STAGES, S);

const scoped = ctx(STAGES[5]);
ok("Reconcile is shown the CONTRACT",   /## Capture/.test(scoped));
ok("Reconcile is shown the OBJECTIONS", /## Critique/.test(scoped));
ok("Reconcile is NOT shown Deepen",     !/DEEPEN-BODY/.test(scoped));
ok("Reconcile is NOT shown Diverge",    !/DIVERGE-BODY/.test(scoped));
ok("status labels still travel",        /_CONTRACT_/.test(scoped) && /_OBJECTIONS_/.test(scoped));

// The honesty requirement: silence about what was withheld is not acceptable.
ok("the withheld stages are NAMED",     /Withheld from this stage/.test(scoped) && /Diverge/.test(scoped) && /Deepen/.test(scoped), scoped.slice(-260));
ok("and absence is explicitly not evidence", /absence as evidence/.test(scoped));

// A stage without `needs` must behave exactly as before.
const unscoped = ctx(STAGES[4]);
ok("an unscoped stage still sees everything before it",
   /DIVERGE-BODY/.test(unscoped) && /DEEPEN-BODY/.test(unscoped) && /STRUCTURE-BODY/.test(unscoped));
ok("an unscoped stage gets NO withheld notice", !/Withheld from this stage/.test(unscoped));
ok("passing no stage at all is still safe",     /DEEPEN-BODY/.test(ctx()));

// The point of the change, measured on REAL sizes from the 2026-08-23 run. With toy bodies the
// withheld notice is longer than the content it replaces, which says nothing useful -- the
// property only means something at the sizes that actually broke the stage.
const REAL = { capture:1807, diverge:642, structure:1088, deepen:12210, critique:2949 };
const Sreal = { stage:5, outputs:Object.fromEntries(Object.entries(REAL).map(([k,n]) => [k,"x".repeat(n)])) };
const ctxR = new Function("STAGES","S", DEMOTE_SRC + html.slice(a,b) + "\nreturn contextSoFar;")(STAGES, Sreal);
const rScoped = ctxR(STAGES[5]).length, rFull = ctxR(STAGES[4]).length;
ok("at real sizes, scoping roughly halves the prompt", rScoped < rFull * 0.6, {scoped:rScoped, full:rFull});
ok("Deepen's 12k is what goes",                        rFull - rScoped > 12000, {saved: rFull - rScoped});

// Nothing yet.
const S0 = { stage: 0, outputs: {} };
const ctx0 = new Function("STAGES","S", DEMOTE_SRC + html.slice(a,b) + "\nreturn contextSoFar;")(STAGES, S0);
ok("an empty run still reads '(nothing yet)'", ctx0(STAGES[0]) === "(nothing yet)", ctx0(STAGES[0]));

console.log(fail ? `context-scope.test.js: ${pass} passed, ${fail} FAILED`
                 : `context-scope.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
