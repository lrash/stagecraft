#!/usr/bin/env node
// 2026-11-18: the autopilot runs every remaining stage without stopping in between, and stops
// (never skips, never decides) wherever runStage refuses to go on by itself.
//   Run:  node tests/autopilot.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const a = html.indexOf("/* ---------- autopilot"), b = html.indexOf("/* ---------- running a stage");
if (a < 0 || b < a) { console.log("FAIL  autopilot section not found"); process.exit(1); }
const SRC = html.slice(a, b);

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

function harness(behaviour, startOutputs = {}){
  const els = {};
  const el = id => els[id] || (els[id] = { hidden: true, textContent: "", disabled: false, attrs: {}, setAttribute(k, v){ this.attrs[k] = v; } });
  el("btn-stop").hidden = true;
  const STAGES = ["capture", "diverge", "structure", "deepen", "critique", "reconcile", "review"].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
  const S = { stage: 0, outputs: Object.assign({}, startOutputs) };
  const calls = [];
  let n = 0;
  const env = {
    S, STAGES, $: el, save(){}, renderAll(){}, stage: () => STAGES[S.stage], busy: false, RUN: null,
    async runStage(){ const s = STAGES[S.stage]; calls.push(s.id); n++; await behaviour(s, S, n, api); },
  };
  const api = {};
  const f = new Function(...Object.keys(env), SRC + "\nreturn { runAll, renderAuto, get AUTO(){ return AUTO; } };");
  const M = f(...Object.values(env));
  api.M = M;
  return { M, S, calls, el };
}
const answer = (s, S) => { S.outputs[s.id] = "answer of " + s.id; S.outputs[s.id + ":run"] = { at: Math.random() }; };

(async () => {
  // 1. every stage answers: all seven run, in order, and it ends on the last stage
  {
    const h = harness(async (s, S) => answer(s, S));
    await h.M.runAll();
    ok("runs all seven stages in order", h.calls.join() === "capture,diverge,structure,deepen,critique,reconcile,review", h.calls);
    ok("ends on the last stage", h.S.stage === 6, h.S.stage);
    ok("says it finished", /finished: 7 stages run/.test(h.el("auto-status").textContent), h.el("auto-status").textContent);
    ok("is no longer running afterwards", h.M.AUTO === null);
  }
  // 2. a stage that saves nothing (a refusal notice) stops the autopilot right there
  {
    const h = harness(async (s, S) => { if (s.id !== "deepen") answer(s, S); });
    await h.M.runAll();
    ok("stops at the stage that did not answer", h.S.stage === 3 && h.calls[h.calls.length - 1] === "deepen", { stage: h.S.stage, calls: h.calls });
    ok("never goes past it", !h.calls.includes("critique"));
    ok("says it paused and why to look", /paused at Deepen after 3 stages/.test(h.el("auto-status").textContent), h.el("auto-status").textContent);
  }
  // 3. an answer that was already there before the run is not taken as a new one
  {
    const stale = { at: 1 };
    const h = harness(async (s, S) => { if (s.id === "structure") { S.outputs.structure = "x"; S.outputs["structure:run"] = stale; } else answer(s, S); },
                      {});
    // simulate: structure "answers" by leaving the same record object it already had
    h.S.outputs["structure:run"] = stale;
    await h.M.runAll();
    ok("an unchanged run record counts as no answer", h.S.stage === 2 && !h.calls.includes("deepen"), { stage: h.S.stage, calls: h.calls });
  }
  // 4. stages that already have an answer are kept, not re-run
  {
    const h = harness(async (s, S) => answer(s, S), { capture: "c", "capture:run": {}, diverge: "d", "diverge:run": {} });
    await h.M.runAll();
    ok("does not re-run stages that have answers", h.calls[0] === "structure" && !h.calls.includes("capture"), h.calls);
    ok("says 5 stages were run", /finished: 5 stages run/.test(h.el("auto-status").textContent), h.el("auto-status").textContent);
  }
  // 5. pressing it again while running stops after the stage in flight
  {
    let hh;
    hh = harness(async (s, S, n) => { answer(s, S); if (n === 2) await hh.M.runAll(); });
    await hh.M.runAll();
    ok("a second press stops after the current stage", hh.calls.join() === "capture,diverge", hh.calls);
    ok("and stays on that stage", hh.S.stage === 1, hh.S.stage);
    ok("says it stopped", /stopped at Diverge after 2 stages/.test(hh.el("auto-status").textContent), hh.el("auto-status").textContent);
  }
  // 6. the button label and state
  {
    const h = harness(async () => {});
    h.M.renderAuto();
    ok("fresh: offers to run all stages", h.el("btn-auto").textContent === "Run all stages automatically");
    h.S.outputs.capture = "c"; h.M.renderAuto();
    ok("partway: offers to run the rest", h.el("btn-auto").textContent === "Run the rest automatically");
    h.S.stage = 6; h.S.outputs.review = "r"; h.M.renderAuto();
    ok("finished on the last stage: disabled", h.el("btn-auto").disabled === true);
  }
  // 7. it only ever calls runStage: no model, key, or quota code lives in this section
  ok("the section calls no provider or router directly", !/\b(pick|chat|cloudFetch|spend|exhaust)\s*\(/.test(SRC));

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
