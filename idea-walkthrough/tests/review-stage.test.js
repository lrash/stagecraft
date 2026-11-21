#!/usr/bin/env node
// PROPOSAL 2026-11-17 (branch proposal-review-stage): Review, stage 7, the plan the author acts on.
//
// Graded blind on the garage idea (the author's blind grading, not published;
// experiments/review/RESULT-2026-11-17.md), the six-stage pipeline never beat one prompt (best
// 8/12 against 8.5-9). With a final stage that writes the plan it scored 11·10 and 11·11. This
// pins what was tested: its place (last), its floor (high), what it is shown (Capture, Critique,
// Reconcile, plus a named withheld note, as experiments/review/build-prompt.js built it), and
// its prompt (review-prompt.md, byte for byte with an empty steering box).
//   Run:  node tests/review-stage.test.js
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const STAGES = new Function(cut("const STAGES = [", "const stage = () =>") + "\nreturn STAGES;")();
const ids = STAGES.map(s => s.id);
const rv = STAGES.find(s => s.id === "review") || {};

// --- place, floor, needs -----------------------------------------------------
ok("Review is the plan, followed only by Check facts", ids[ids.length - 2] === "review" && ids[ids.length - 1] === "verify", ids);
ok("...after Reconcile, with the first six unchanged and in order (Check facts after it: 2026-11-18)",
   ids.join() === "capture,diverge,structure,deepen,critique,reconcile,review,verify", ids);
ok("Review's floor is high", rv.floor === "high", rv.floor);
ok("Review needs exactly capture, critique, reconcile",
   JSON.stringify(rv.needs) === JSON.stringify(["capture", "critique", "reconcile"]), rv.needs);
ok("Review declares a PLAN status that introduces no facts",
   /^PLAN — the deliverable\./.test(rv.status || "") && /introduces no facts/.test(rv.status || ""), rv.status);
ok("Review has the UI fields every stage has", ["name", "note", "sub", "label"].every(k => typeof rv[k] === "string" && rv[k].length > 0));

// --- the prompt --------------------------------------------------------------
const p = String(rv.prompt ? rv.prompt("IDEA-TEXT", "CTX-TEXT", "") : "");
ok("asks for PART 1 — BEFORE YOU START", p.includes("PART 1 — BEFORE YOU START."));
ok("asks for PART 2 — THE PLAN", p.includes("PART 2 — THE PLAN."));
ok("asks for PART 3 — WHAT THE PLAN ANSWERS", p.includes("PART 3 — WHAT THE PLAN ANSWERS."));
ok("...in that order", p.indexOf("PART 1 —") < p.indexOf("PART 2 —") && p.indexOf("PART 2 —") < p.indexOf("PART 3 —"));
ok("...and exactly three parts", /Produce exactly three parts\./.test(p) && !/PART 4/.test(p));
ok("the first step is something the author can start today",
   p.includes("The first step must be something the author can start today."));
ok("every MUST in the contract is covered", p.includes("Cover every MUST in the contract."));
ok("Part 1 is only the blocking UNKNOWNs, and may be empty",
   /contract's UNKNOWNs that the plan cannot be finished without/.test(p) && p.includes('"nothing blocks the plan"'));
ok("it may not invent facts or add requirements",
   /Do not invent facts about the author/.test(p) && /Do not add requirements the author did not give/.test(p));
ok("the contract is binding and the idea is quoted verbatim",
   /The CONTRACT is binding\./.test(p) && p.includes("ORIGINAL IDEA, VERBATIM:\nIDEA-TEXT\n\nTHE RUN:\nCTX-TEXT\n"));

// The wording, byte for byte, with {{IDEA}} and {{CONTEXT}} left in. v2 (graded 2026-11-17):
// 8c6e981a…6352. v3 (2026-11-18) = v2 plus one sentence on the FACT CHECK; saved as
// review prompt v3 from the author's grading notes, and graded with the Check facts stage.
const TEMPLATE_SHA = "8c6e981a373fdbfc94bf68813a51fee6013b194a027e457849de208afe9b6352";   // v2 again: v3 was graded with the check BEFORE Review and lost (blind15-16)
const tpl = String(rv.prompt ? rv.prompt("{{IDEA}}", "{{CONTEXT}}", "") : "");
ok("with an empty steering box the prompt is the graded review-prompt.md",
   crypto.createHash("sha256").update(tpl).digest("hex") === TEMPLATE_SHA, tpl.slice(0, 120));

// The optional steering line, as the other stages do it: absent when empty, once and before the
// idea when given.
const steered = String(rv.prompt ? rv.prompt("I", "C", "a two-hour budget") : "");
ok("no steering line when the box is empty", !/The author asks the plan to account for/.test(p));
ok("the steering line appears once, after the rules and before the idea",
   steered.split("The author asks the plan to account for: a two-hour budget").length === 2
   && steered.indexOf("The author asks the plan to account for:") > steered.indexOf("No preamble, no summary.")
   && steered.indexOf("The author asks the plan to account for:") < steered.indexOf("ORIGINAL IDEA, VERBATIM:"), steered.slice(-200));

// --- what it is shown --------------------------------------------------------
const CTX = cut("const contextSoFar = (stage) => {", "/* ---------- rendering");
const DEMOTE = cut("function demoteHeadings(s){", "function exportName(){");
const outputs = { capture: "CAPTURE-BODY", diverge: "DIVERGE-BODY", structure: "STRUCTURE-BODY",
                  deepen: "DEEPEN-BODY", critique: "CRITIQUE-BODY", reconcile: "RECONCILE-BODY", verify: "VERIFY-BODY" };
const S = { stage: ids.indexOf("review"), outputs };
const ctxOf = new Function("STAGES", "S", DEMOTE + CTX + "\nreturn contextSoFar;")(STAGES, S);
const got = ctxOf(rv);
// What experiments/review/build-prompt.js assembled for the graded runs.
const by = id => STAGES.find(s => s.id === id);
const want = ["capture", "critique", "reconcile"].map(id => "## " + by(id).name + "\n_" + by(id).status + "_\n" + outputs[id]).join("\n\n")
  + "\n\n## Withheld from this stage\n_Diverge, Structure, Deepen also ran. Their material reached you only through the objections and the audit._";
ok("Review's context: Capture, Critique, Reconcile, Check facts, and the named withheld note", got === want, got);
ok("...so it is not shown Diverge, Structure or Deepen", !/DIVERGE-BODY|STRUCTURE-BODY|DEEPEN-BODY/.test(got));

// Reconcile keeps its own withheld note.
S.stage = ids.indexOf("reconcile");
const rec = ctxOf(by("reconcile"));
ok("Reconcile's withheld note is unchanged",
   rec.endsWith("_Diverge, Structure, Deepen also ran and produced output. It is deliberately not shown here, because this stage"
     + " audits against the contract rather than re-reading the whole run. Do NOT treat its absence as evidence that nothing"
     + " was proposed there._"), rec.slice(-300));

// --- what else follows the table ---------------------------------------------
ok("Review has no fill-in template for the placeholder guard", !/\breview\s*:/.test(cut("const TEMPLATE_SLOTS = {", "const ECHO_MAX")));
ok("the desktop self-test takes its stage ids from the page", /stageIds: \(\) => STAGES\.map\(s => s\.id\)/.test(html)
   && /const STAGE_IDS = ctx\.stageIds \? ctx\.stageIds\(\) :/.test(html));
ok("STAGE=all is ok only when every stage ran", /stages\.length === STAGE_IDS\.length && stages\.every/.test(html) && !/stages\.length === 6/.test(html));
ok("the local ceiling copy names what a below-floor Review costs", /review:"a thinner plan"/.test(html));

ok("v2: no step waits on an answer; a default is marked and its alternative given",
   /Never make a step wait on an answer\./.test(p) && /\(default; if Q3 says weekends only/.test(p));
ok("v2: 'not asked for' is not a reason to decline an objection", /never decline an objection because of it/.test(p));
console.log(fail ? `review-stage.test.js: ${pass} passed, ${fail} FAILED` : `review-stage.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
