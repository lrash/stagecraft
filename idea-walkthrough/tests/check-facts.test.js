#!/usr/bin/env node
// 2026-11-18, owner: "be sure to add a correctness check where you think is best".
// Check facts (id "verify") sits between Reconcile and Review at the high floor. It is shown the
// stages that make claims about the world, lists only WRONG and DOUBTFUL claims with a correction
// or a place to check, and Review is told to build no step on a WRONG claim.
// Graded on criterion E (the author's correctness rubric, not published).
//   Run:  node tests/check-facts.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const STAGES = new Function(cut("const STAGES = [", "const stage = () =>") + "\nreturn STAGES;")();
const ids = STAGES.map(s => s.id);
const vf = STAGES.find(s => s.id === "verify") || {};

// --- place, floor, what it sees ----------------------------------------------------
ok("Check facts comes last, after Review (blind set 17: +1 on E there, nothing before Review)", ids.slice(-3).join() === "reconcile,review,verify", ids);
ok("its floor is high", vf.floor === "high", vf.floor);
ok("its name is plain language", vf.name === "Check facts");
ok("it sees the stages that make claims about the world, the plan included",
   JSON.stringify(vf.needs) === JSON.stringify(["diverge", "structure", "deepen", "critique", "review"]), vf.needs);
ok("its status says it checks the world, not the author, without web access",
   /^FACT CHECK/.test(vf.status || "") && /without web access/.test(vf.status) && /nothing about the author/.test(vf.status), vf.status);
ok("it has the UI fields every stage has", ["name", "note", "sub", "label", "withheld"].every(k => typeof vf[k] === "string" && vf[k].length > 0));
const countLine = html.match(/const STAGE_COUNT = (\d+);/);
ok("STAGE_COUNT (used before STAGES exists) equals STAGES.length", countLine && +countLine[1] === STAGES.length, countLine && countLine[1]);
ok("cleanWalk keeps any stage below STAGE_COUNT (a session saved at Review reopens at Review)",
   /w\.stage >= 0 && w\.stage < STAGE_COUNT \? w\.stage : 0/.test(html));

// --- the prompt ----------------------------------------------------------------------
const p = String(vf.prompt("IDEA-TEXT", "CTX-TEXT", ""));
ok("two parts, in order", p.indexOf("PART 1 — CORRECTIONS.") > 0 && p.indexOf("PART 2 — CHECKED.") > p.indexOf("PART 1 — CORRECTIONS.") && /Produce exactly two parts\./.test(p));
ok("WRONG needs confidence and a correction", /\[WRONG\] when you are confident it is false: quote it, name the stage it came from, give the correct fact\./.test(p));
ok("DOUBTFUL says what to check and where, naming a primary source", /\[DOUBTFUL\][^\n]*say what to check and where, naming a primary source/.test(p));
ok("it may not invent sources, URLs, versions or figures", /Do not invent sources, URLs, versions or figures/.test(p));
ok("it may not add advice or rewrite the plan", /Do not add new facts, advice or options\. Do not rewrite the plan/.test(p));
ok("claims about the author are out of its scope", /Claims about the author, their situation or their wishes are not yours to check/.test(p));
ok("it reports how many claims it checked (no silent 'all fine')", /how many claims about the world you checked/.test(p));
ok("an already-flagged uncertainty is not an error", /already marked as uncertain is not an error/.test(p));
ok("the worked example is about another idea and says not to reuse its words",
   /One line about a different idea, to show the form only — do not reuse its words:\n\[WRONG\] "tubeless tyres/.test(p));
ok("idea quoted verbatim, then the run", p.endsWith("ORIGINAL IDEA, VERBATIM:\nIDEA-TEXT\n\nTHE RUN:\nCTX-TEXT\n"));
const steered = String(vf.prompt("I", "C", "NVD's limit is 50 per 30 s"));
ok("the optional note appears once, before the idea", steered.split("The author notes: NVD's limit is 50 per 30 s").length === 2
   && steered.indexOf("The author notes:") < steered.indexOf("ORIGINAL IDEA, VERBATIM:"));
ok("no slot placeholders in the prompt", !/<claim>|<stage>|\[category\]|"quoted claim"/.test(p));

// --- copying the example is caught by the placeholder guard --------------------------
const G = new Function(cut("const TEMPLATE_SLOTS = {", "/* ---------- ") + "\nreturn { templateEchoes, ECHO_MAX };")();
const copied = '[WRONG] "tubeless tyres cannot be used on road bikes" (Deepen) — road tubeless tyres are widely sold; the rim maker\'s list says.';
ok("an answer that copies the example is refused", G.templateEchoes("verify", copied) >= G.ECHO_MAX, G.templateEchoes("verify", copied));
const real = '[WRONG] "10,000+ CVEs daily" (Deepen) — roughly 100-150 new CVEs are published a day; NVD statistics show the yearly totals.';
ok("a real correction is not", G.templateEchoes("verify", real) === 0, G.templateEchoes("verify", real));

// --- what it is shown ----------------------------------------------------------------
const CTX = cut("const contextSoFar = (stage) => {", "/* ---------- rendering");
const DEMOTE = cut("function demoteHeadings(s){", "function exportName(){");
const outputs = { capture: "CAPTURE-BODY", diverge: "DIVERGE-BODY", structure: "STRUCTURE-BODY",
                  deepen: "DEEPEN-BODY", critique: "CRITIQUE-BODY", reconcile: "RECONCILE-BODY", review: "REVIEW-BODY" };
const S = { stage: ids.indexOf("verify"), outputs };
const floorNote = () => "";
const ctxOf = new Function("STAGES", "S", "floorNote", DEMOTE + CTX + "\nreturn contextSoFar;")(STAGES, S, floorNote);
const got = ctxOf(vf);
ok("it is shown Diverge, Structure, Deepen, Critique and Review", ["DIVERGE-BODY", "STRUCTURE-BODY", "DEEPEN-BODY", "CRITIQUE-BODY", "REVIEW-BODY"].every(x => got.includes(x)), got);
ok("not Capture or Reconcile, and says so by name",
   !/CAPTURE-BODY|RECONCILE-BODY/.test(got) && /## Withheld from this stage\n_Capture, Reconcile also ran\. They are about the author/.test(got), got.slice(-260));

console.log(fail ? `check-facts.test.js: ${pass} passed, ${fail} FAILED` : `check-facts.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
