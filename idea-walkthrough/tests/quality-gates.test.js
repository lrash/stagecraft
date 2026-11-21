#!/usr/bin/env node
// 2026-11-18: quality gates and one revision (owner: "cycle back through if we can tell the
// current stage's answer needs improvement"). Deterministic checks; one revision per stage run, on
// the same model; never upstream; what still fails is stamped and travels downstream.
//   Run:  node tests/quality-gates.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };
let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const SRC = cut("/* ---------- grounding check", "const DIVERGE_MIN_WORDS");
const S = { idea: "", outputs: {} };
const G = new Function("S", SRC + "\nreturn { gateCheck, reviewGate, reconcileGate, verifyGate, revisionNote, gateNote, p3Mismatches };")(S);

const steps = n => Array.from({ length: n }, (_, i) => `${i + 1}. Do concrete thing number ${i + 1} today (default; if Q1 says otherwise, adjust).`).join("\n");
const review = (q, n, p3) => `PART 1 — BEFORE YOU START\n${q}\n\nPART 2 — THE PLAN\n${steps(n)}\n\nPART 3 — WHAT THE PLAN ANSWERS\n${p3}`;
const twoQs = "1. Which systems are in scope?\n2. Who receives the findings?";

// --- Review --------------------------------------------------------------------------------
ok("a sound plan passes", G.reviewGate(review(twoQs, 6, "Objection 1: Step 2 and Step 6 cover it.")).failures.length === 0,
   G.reviewGate(review(twoQs, 6, "Objection 1: Step 2 and Step 6 cover it.")));
ok("fewer than 5 steps fails", /3 numbered steps/.test(G.reviewGate(review(twoQs, 3, "-")).failures.join()));
ok("a missing part fails", /PART 1, PART 2 and PART 3/.test(G.reviewGate("PART 1 — x\nPART 2 — y").failures.join()));
ok("parts out of order fail", G.reviewGate("PART 2 — y\nPART 1 — x\nPART 3 — z").failures.length === 1);
ok("Part 3 citing a step that does not exist fails", /names step 9, but PART 2 has 6 steps/.test(G.reviewGate(review(twoQs, 6, "Objection 4: Step 9 handles it.")).failures.join()),
   G.reviewGate(review(twoQs, 6, "Objection 4: Step 9 handles it.")));
ok("a Q number beyond Part 1's questions fails", /cites Q4, but PART 1 has 2 questions/.test(
   G.reviewGate(review(twoQs, 6, "Objection 1: step 2 (if Q4 is no).")).failures.join()));
ok("unnumbered questions ending in ? are counted", G.reviewGate(review("Which systems are in scope?\nWho gets the findings?\nWhat budget?", 6, "-")).failures.length === 0);
{ // the garage run (2026-11-18): "Q1: Who…? (e.g., …)" lines end in ")" and were counted as 0 questions
  const qLab = Array.from({ length: 7 }, (_, i) => `Q${i + 1}: Who is the primary user? (e.g., homeowner, renter)`).join("\n");
  ok("Q-labelled questions ending in ')' are counted", G.reviewGate(review(qLab, 6, "Objection 1: step 2 (if Q7 is no).")).failures.length === 0,
     G.reviewGate(review(qLab, 6, "Objection 1: step 2 (if Q7 is no).")));
  ok("…and Q8 beyond them still fails", /cites Q8, but PART 1 has 7 questions/.test(G.reviewGate(review(qLab, 6, "Objection 1: step 2 (if Q8 is no).")).failures.join()));
}
ok("'nothing blocks the plan' means any Q citation is wrong", /cites Q1, but PART 1 has 0 questions/.test(G.reviewGate(review("nothing blocks the plan", 6, "-")).failures.join()));
ok("markdown headings and bold step numbers are understood",
   G.reviewGate("## PART 1 — BEFORE\n1. Q?\n\n**PART 2 — THE PLAN**\n" + steps(5).replace(/^(\d+)\./gm, "**$1.**") + "\n\n### PART 3 — ANSWERS\nObjection: Step 5.").failures.length === 0);

// --- Review Part 3 content (2026-11-18 evening; precision-tuned on 257 labelled claims) -------------
{
  const P2 = "PART 2 — THE PLAN\n1. Write a 20-question text interview script covering garage zones, pain points and household sharing.\n"
    + "2. Create a checklist of 10 wide-angle shots and 5 close-ups.\n3. Tag each zone with clutter level and hazard flags.\n"
    + "4. Generate a PDF action plan with local disposal links.\n5. Test with three users.";
  const rv = p3 => "PART 1 — BEFORE YOU START\n1. Who is it for?\n\n" + P2 + "\n\nPART 3 — WHAT THE PLAN ANSWERS\n" + p3;
  ok("a Part 3 line that says what the step says passes", G.reviewGate(rv("Household dynamics — met in Step 1 by interview questions about household sharing.")).failures.length === 0,
     G.reviewGate(rv("Household dynamics — met in Step 1 by interview questions about household sharing.")));
  ok("a claim the cited step does not contain fails (the judges' garage example)",
     /PART 3 says step 4 covers "including pickup scheduling info and municipal weighting", but that step does not mention/.test(
       G.reviewGate(rv("No disposal pathway — met in Step 4 by including pickup scheduling info and municipal weighting.")).failures.join()),
     G.reviewGate(rv("No disposal pathway — met in Step 4 by including pickup scheduling info and municipal weighting.")));
  ok("reasoning after the claim is not read as a claim", G.reviewGate(rv("Hands-on help — step 5 tests with users — plan does not provide hands-on help or mediate household conflicts (out of scope).")).failures.length === 0);
  ok("a parenthesis after the step is the claim", G.p3Mismatches(P2, "PART 3\n- Objection 8: addressed in step 3 (vendor contracts, SLAs, escalation rotas, renewal calendars)").length === 1);
  ok("short claims are never flagged (fewer than 4 content words)", G.p3Mismatches(P2, "PART 3\n- met by step 2 (drone footage)").length === 0);
  ok("a step that does not exist is left to the step-number check", G.p3Mismatches(P2, "PART 3\n- met by step 9 (unrelated widgets, gadgets, sprockets, flanges)").length === 0);
  const note = G.revisionNote("review", { failures: ['PART 3 says step 4 covers "x", but that step does not mention y'] });
  ok("the Review revision note says to fix Part 3 or the step, never to invent a requirement", /add it to that step in PART 2 \(only if the contract calls for it\) or change PART 3/.test(note), note);
}

// --- Reconcile --------------------------------------------------------------------------------
const src = ("Design a business process matrix tying client fulfillment and payroll to systems, assets, software, hardware, licensing; "
           + "log process ownership and contact info; understand downtime impact. MUST map assets. UNKNOWN who maintains it.").toLowerCase();
const run = { critique: "[High] The plan assumes Kubernetes microservices on AWS scale constantly.\n[Medium] It ignores ServiceNow and Salesforce integrations.\n[Low] Payroll runs on Workday.",
              deepen: "Use Neo4j to model it." };
const rec = "PART 1 — DISCREPANCIES\nno discrepancies found\n\nPART 2 — WHAT SURVIVES\n- MUSTs";
const gr = G.reconcileGate(rec, run, src);
ok("'no discrepancies' while the run names things the contract never mentions fails", gr.failures.length === 1 && /reports no discrepancies, but \d+ lines/.test(gr.failures[0]), gr);
ok("...and the revision note quotes those lines", gr.lines.length >= 2 && gr.lines.some(l => /Kubernetes/.test(l)), gr.lines);
ok("a Reconcile that found discrepancies is not second-guessed", G.reconcileGate("PART 1 — DISCREPANCIES\n[INVENTED FACT] \"Kubernetes\" — introduced at Critique", run, src).failures.length === 0);
ok("'no discrepancies' on a run that introduces nothing passes",
   G.reconcileGate(rec, { critique: "the matrix may go stale if nobody maintains it", deepen: "map each asset to its system" }, src).failures.length === 0);

// --- Check facts ------------------------------------------------------------------------------
ok("tagged corrections with a count pass", G.verifyGate('[WRONG] "x" (Deepen) — y.\n\nChecked 18 claims about the world; confident 12 are correct.').failures.length === 0);
ok("'no corrections' with a count passes", G.verifyGate("PART 1 — CORRECTIONS\nno corrections\n\nPART 2 — CHECKED\n9 claims checked, all fine.").failures.length === 0);
ok("an answer with no count fails (no silent 'all fine')", /how many claims/.test(G.verifyGate("no corrections").failures.join()));
ok("prose without tags fails", /no \[WRONG\] or \[DOUBTFUL\] lines/.test(G.verifyGate("Everything looks right. Checked 4 claims.").failures.join()));

// --- dispatch, notes, stamps --------------------------------------------------------------------
ok("stages without a gate always pass", ["capture", "diverge", "structure", "deepen", "critique"].every(id => G.gateCheck(id, "", {}, src).failures.length === 0));
const note = G.revisionNote("reconcile", gr);
ok("the reconcile revision note names the failure, lists the lines and asks for the whole answer again",
   /^\n\nREVISION NOTE — an automatic check/.test(note) && /- \[High\] The plan assumes Kubernetes/.test(note) && /write your whole answer again, in the same parts/.test(note), note);
ok("the note never includes the previous answer", !note.includes("WHAT SURVIVES"));
// 2026-11-18 evening: the first note made Reconcile tag "Proposal 2" / "Structure Step 7" and the
// contract's own UNKNOWNs as invented (garage), and every objection (BPM). The note now says what is not one.
ok("the note says citing earlier stages (Proposal N, Step N) is not an invention", /not shown[\s\S]*"Proposal N", "Step N"[\s\S]*not inventing/.test(note), note);
ok("the note says a possibility or a contract UNKNOWN is not an invention", /possibility[\s\S]*UNKNOWN, is not an invention/.test(note));
ok("the note limits INVENTED FACT to claims stated as fact, and says most objections are fair", /INVENTED FACT is only for a claim stated as fact/.test(note) && /do not tag every one/.test(note));
ok("the whole answer is still asked for last", /\nThen write your whole answer again, in the same parts\.$/.test(note));
S.outputs = { review: "x", "review:gate": { failures: ["PART 3 names step 9, but PART 2 has 6 steps"], revised: true } };
ok("a gate that still fails travels downstream with the answer", /an automatic check still flags this answer: PART 3 names step 9/.test(G.gateNote("review")));
ok("no stamp, no note", G.gateNote("critique") === "");

// --- wiring in runStage ---------------------------------------------------------------------------
const rs = cut("async function runStage(", "async function discloseSend(");
ok("the gate runs after the answer is saved, with the run's outputs and the contract",
   /const g = gateCheck\(s\.id, text, S\.outputs, sourceText\(\)\);/.test(rs));
ok("at most one revision per stage run, only when allowed", /if \(g\.failures\.length && !rev && attempts < MAX_ATTEMPTS && gateAllowed\(c\)\)\{/.test(rs));
ok("the revision reuses the same model (c unchanged) and loops once more", /rev = \{ note: revisionNote\(s\.id, g\) \};[\s\S]{0,400}continue;/.test(rs));
ok("both the consent panel and the call get the same prompt, note included",
   /discloseSend\(s, c, promptOf\(\)\)/.test(rs) && /\.chat\(S\.keys\[c\.provider\], c\.id, promptOf\(\),/.test(rs));
const allowed = cut("function gateAllowed(c){", "\n}") ;
ok("an autopilot run allows two revisions in all", /AUTO\.revisions \|\| 0\) >= 2\) return false/.test(allowed));
ok("a metered provider keeps two calls in hand", /left\(c\.provider\) >= 3/.test(allowed));
ok("the floor note carries the gate note into context and export", /\+ \(typeof gateNote === "function" \? gateNote\(id\) : ""\)/.test(html));

console.log(fail ? `quality-gates.test.js: ${pass} passed, ${fail} FAILED` : `quality-gates.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
