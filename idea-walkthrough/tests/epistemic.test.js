// Epistemic invariants — the guardrails that stop a proposal becoming a fact.
//
// Written 2026-08-22 after a third-party review of a real run by a non-technical user.
// A quilting-pattern run went: Diverge speculated about progress bars -> Deepen reasoned
// about them as settled -> Critique assigned severities to consequences of invented
// premises -> the output recommended a CUT button on a printed piece of paper. Origin was
// never lost; STATUS was never carried at all.
const assert = require("assert");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");
const _da = html.indexOf("function demoteHeadings(s){"), _db = html.indexOf("function exportName(){");
const DEMOTE_SRC = html.slice(_da, _db);

let n = 0, bad = 0;
const ok = (msg, cond, extra) => { if (cond) { n++; } else { bad++; console.log("FAIL  " + msg + (extra !== undefined ? "  [" + extra + "]" : "")); } };

// Lift the stage table without executing the whole page.
const i = html.indexOf("const STAGES = [");
const stagesSrc = html.slice(i, html.indexOf("\n];", i) + 3);
const stageOf = id => {
  const j = stagesSrc.indexOf('id:"' + id + '"');
  if (j < 0) return null;
  const end = stagesSrc.indexOf('\n  { id:"', j + 1);
  return stagesSrc.slice(j, end < 0 ? undefined : end);
};
const ids = [...stagesSrc.matchAll(/id:"([a-z]+)", name:/g)].map(m => m[1]);

// --- every stage declares its status -----------------------------------------
// A stage without one is invisible to the context stamp, which is the whole defence.
ids.forEach(id => ok(id + " declares a status", /status:"/.test(stageOf(id)), id));

// --- the status must be stamped at the JOIN, not left to the prompt -----------
// Anchored on the function BODY, not on a character distance from its name. The previous
// form allowed 600 chars and broke the moment contextSoFar grew a comment -- a test boundary
// chosen for convenience rather than stability.
const _ca = html.indexOf("const contextSoFar = (stage) => {");
const _cb = html.indexOf("/* ---------- rendering");
const CTX_BODY = html.slice(_ca, _cb);
ok("contextSoFar stamps status into the context", /s\.status/.test(CTX_BODY));
ok("...and sanitises the stage output it frames",  /demoteHeadings\(S\.outputs\[s\.id\]\)/.test(CTX_BODY));

// --- the stage that writes the contract cannot be the cheapest ----------------
// Routing the constitution through the weakest model is the Consolidate mistake inverted.
ok("Capture is not a low-tier stage", /id:"capture"[\s\S]{0,80}floor:"(medium|high)"/.test(html),
   (html.match(/id:"capture"[\s\S]{0,80}floor:"[a-z]+"/) || [""])[0]);

// --- Diverge output must be marked speculative --------------------------------
ok("Diverge is stamped PROPOSALS", /id:"diverge"[\s\S]{0,200}status:"PROPOSALS/.test(html));
ok("Diverge is told its output is not findings", /PROPOSALS, not findings/.test(stageOf("diverge") || ""));

// --- Critique severity must not read as a truth claim -------------------------
const crit = stageOf("critique") || "";
ok("Critique status separates consequence from truth",
   /IF the premise holds/i.test(crit) && /NOT a finding that the premise is true/i.test(crit));

// --- Capture must refuse to import domain knowledge ---------------------------
const cap = stageOf("capture") || "";
ok("Capture forbids adding domain knowledge", /Add NO domain knowledge/i.test(cap));
ok("Capture routes unknowns to questions, not facts", /belongs under UNKNOWN as a question/i.test(cap));
ok("Capture refuses to improve the idea", /recording it, not helping it/i.test(cap));
["SOURCE FACTS","MEDIUM","MUST NOT","UNKNOWN","OUT OF SCOPE"].forEach(h =>
  ok("Capture contract has a " + h + " section", cap.includes(h), h));

// --- Reconcile: an audit, not a summary ---------------------------------------
const rec = stageOf("reconcile") || "";
ok("Reconcile exists", rec.length > 0);
// PROPOSAL 2026-11-17: Review follows Reconcile (tests/review-stage.test.js); 2026-11-18 the fact check
// sits between them (tests/check-facts.test.js).
ok("Reconcile, then Review, then Check facts, last", ids.slice(-3).join() === "reconcile,review,verify", ids.join(","));
ok("Reconcile gets a high-tier model", /floor:"high"/.test(rec));
ok("Reconcile refuses to summarise", /NOT summarising/i.test(rec));
["INVENTED FACT","UNSUPPORTED","MEDIUM VIOLATION","BREACHES MUST NOT","SCOPE CREEP","DROPPED"].forEach(c =>
  ok("Reconcile can report " + c, rec.includes(c), c));
// The specific laundering path that started all this.
ok("Reconcile knows a Critique severity is not evidence",
   /severity assigned by the Critique stage is NOT evidence/i.test(rec));
ok("Reconcile knows plausible is not established",
   /Being right is not the same as being established/i.test(rec));
ok("Reconcile is forbidden from padding", /Do not pad/i.test(rec));
ok("Reconcile sees the original idea verbatim", /ORIGINAL IDEA, VERBATIM/.test(rec));

console.log((bad ? "FAILED " : "") + n + " assertions passed" + (bad ? ", " + bad + " failed" : ""));
process.exit(bad ? 1 : 0);
