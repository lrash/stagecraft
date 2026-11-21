#!/usr/bin/env node
// Placeholder guard (2026-11-17). Below their high floor, Critique and Reconcile returned their own
// output template ("— what it costs.", "what the contract actually says") and the app saved it as an
// answer. The guard turns two or more left-in slots into a failed attempt. Lines below are modelled on
// the graded garage runs (the author's grading: v6 original, local re-run, two Nemotron runs).
//   Run:  node tests/placeholder-guard.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const from = html.indexOf("const TEMPLATE_SLOTS = {");
const to = html.indexOf("/* A response that came back", from);
ok("guard block found", from > -1 && to > from);
const G = new Function(html.slice(from, to) + "\nreturn { TEMPLATE_SLOTS, ECHO_MAX, templateEchoes, shapeFail };")();

// --- what the small model did (v6): every objection ends in the bare slot -------------------
const v6Critique = [
  "**Critical** Form — what breaks — what it costs.",
  "**High** Image Handling — assuming AI can accurately classify items — what it costs.",
  "**High** Interview Method — assuming users will answer honestly — what it costs.",
  "**Medium** Data protection — assuming compliance (e.g., GDPR) — what it costs.",
].join("\n");
const v6Reconcile = [
  "PART 1 — DISCREPANCIES",
  "[INVENTED FACT] \"assuming AI can accurately classify items\" — introduced at Critique — what the contract actually says",
  "[INVENTED FACT] \"assuming users will answer honestly\" — introduced at Critique — what the contract actually says",
  "[INVENTED FACT] \"subscription fees\" — introduced at Critique — what the contract actually says",
].join("\n");
ok("v6 Critique fails the guard", G.templateEchoes("critique", v6Critique) >= G.ECHO_MAX, G.templateEchoes("critique", v6Critique));
ok("v6 Critique: the all-slot line counts both slots", G.templateEchoes("critique", "**Critical** Form — what breaks — what it costs.") === 2);
ok("v6 Reconcile fails the guard", G.templateEchoes("reconcile", v6Reconcile) >= G.ECHO_MAX, G.templateEchoes("reconcile", v6Reconcile));
ok("the untouched Reconcile template line counts every slot",
   G.templateEchoes("reconcile", '[category] "quoted claim" — introduced at <stage> — what the contract actually says') === 4);

// --- what must pass ------------------------------------------------------------------------
const filledCritique = [
  "**[Critical] Core premise — assumes assessment is the bottleneck — the plan becomes another unactionable artifact**",
  "**[Low] Timeline UNKNOWN (#4) treats delivery speed as a toggle — a delayed plan misses the window of willingness**",
].join("\n");
const partialCritique = [
  "**[SEVERE] MUST — action plan — what breaks if it's only diagnosis without solutions — user frustration.**",
  "**[HIGH] MUST — timeline — what breaks if delivery is delayed (e.g., 24 hours) — lost urgency.**",
].join("\n");
const filledReconcile = "[INVENTED FACT] \"misses hazards (mold, pests)\" — introduced at Critique — contract never mentions hazards";
ok("a filled-in Critique passes", G.templateEchoes("critique", filledCritique) === 0);
ok("a slot phrase followed by real content passes", G.templateEchoes("critique", partialCritique) === 0);
ok("a filled-in Reconcile passes", G.templateEchoes("reconcile", filledReconcile) === 0);
ok("the phrase used in a sentence passes", G.templateEchoes("critique", "Work out what it costs to store the photos first.") === 0);
ok("one stray slot does not fail the attempt", G.templateEchoes("critique", "x — assuming y — what it costs.") < G.ECHO_MAX);
ok("other stages are never checked", G.templateEchoes("capture", v6Critique + "\n" + v6Reconcile) === 0
   && G.templateEchoes("deepen", v6Critique) === 0);
ok("every guarded stage exists in the stage table",
   Object.keys(G.TEMPLATE_SLOTS).every(id => html.includes('{ id:"' + id + '"')));

// --- it is a failed, delivered attempt, retried once ----------------------------------------
const e = G.shapeFail("qwen3:14b", 36);
ok("shapeFail is delivered (it counts against an allowance)", e.delivered === true);
ok("shapeFail carries the count", e.templateEcho === 36);
const ca = html.indexOf("function classifyAttempt(e){"), cb = html.indexOf("\n}", ca) + 2;
const classifyAttempt = new Function(html.slice(ca, cb) + "\nreturn classifyAttempt;")();
ok("classified as template-echo", classifyAttempt(e).reason === "template-echo" && classifyAttempt(e).outcome === "fail");
ok("retried once on the same model", /"template-echo":\s*"retry"/.test(html));

// --- wired into the run, before anything is saved or counted as an answer --------------------
const run = html.slice(html.indexOf("async function runStage("));
const guardAt = run.indexOf("templateEchoes(s.id, text)"), savedAt = run.indexOf("S.outputs[s.id] = text;"), sentAt = run.indexOf("noteSent(c.provider, s.id);");
ok("runStage checks the answer", guardAt > -1);
ok("...before saving it", guardAt > -1 && guardAt < savedAt);
ok("...and before counting it as answered", guardAt > -1 && guardAt < sentAt);
ok("the failure notice names what happened", /The model filled in the form instead of answering/.test(html));
ok("...and says nothing was saved", /Nothing was saved for this stage: an answer made of the template's own words/.test(html));

// --- 2026-11-17: worked example instead of slots ---------------------------------------------
{
  const G2 = new Function(html.slice(html.indexOf("const TEMPLATE_SLOTS = {"), html.indexOf("/* A response that came back"))
    + "\nreturn { templateEchoes, ECHO_MAX };")();
  ok("Critique's prompt shows a finished example, not slots", /\*\*\[High\] Daily 6 a\.m\. starter feeding/.test(html)
     && !/\*\*\[severity\] target — what breaks — what it costs\.\*\*/.test(html));
  ok("Reconcile's prompt shows a finished example, not slots", /\[INVENTED FACT\] "the bakery opens at 7 a\.m\."/.test(html)
     && !/\[category\] "quoted claim" — introduced at <stage>/.test(html));
  const copied = "**[High] Daily 6 a.m. starter feeding — the baker never said — the first week's loaves fail.**";
  ok("copying the Critique example fails the guard", G2.templateEchoes("critique", copied) >= G2.ECHO_MAX);
  ok("copying the Reconcile example fails the guard",
     G2.templateEchoes("reconcile", '[INVENTED FACT] "the bakery opens at 7 a.m." — introduced at Structure — the contract gives no opening time') >= G2.ECHO_MAX);
  ok("a garage objection in the example's form passes",
     G2.templateEchoes("critique", "**[High] Photo upload — the author never said who takes the photos — the assessment guesses at zones it cannot see.**") === 0);
}
console.log(`placeholder-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
