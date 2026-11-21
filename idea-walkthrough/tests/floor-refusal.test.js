#!/usr/bin/env node
// Which of THREE refusals runStage reports, and whether it offers the way out it already has.
//
// 2026-08-23 review, CRITICAL: a local-only install could not run any stage. classifyLocal()
// caps anything under 12B at "low", so an ordinary Ollama roster is ["low"x6] while Capture's
// floor is "medium". pick() returned {ok:false, exhausted:[], fallback:<the 8b>} -- and
// runStage tested `res.exhausted.length === 0` FIRST, reported "none is connected", and
// returned ABOVE the autoLower branch and the accept buttons. The fallback it had already
// computed was discarded. Five of six stages were unrunnable while the gauge read "Local
// infinity" and the card read "6 MODELS".
//   Run:  node tests/floor-refusal.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const i = html.indexOf("  const res = forced ? { ok:true, choice:forced } : pick(s.floor);");
const j = html.indexOf("busy = true; $(\"btn-run\").disabled = true;");
const block = html.slice(i, j);
ok("located the refusal block", i > 0 && j > i);

// Structural: the early return must no longer swallow a usable fallback.
ok("the bail-out requires BOTH no-fallback and nothing-connected",
   /nothingConnected \|\| \(res\.exhausted\.length === 0 && !res\.fallback\)/.test(block));
ok("a capability ceiling is distinguished from a spent allowance",
   /const ceiling = res\.exhausted\.length === 0/.test(block));

// Ordering is the whole defect: the fallback offer must come AFTER the bail-out, and the
// bail-out must not be reachable when a fallback exists.
const bail = block.indexOf("nothingConnected ||");
const auto = block.indexOf("res.fallback && S.autoLower");
const accept = block.indexOf('id="btn-accept"');
ok("autoLower is reachable (below the bail-out)", auto > bail, { bail, auto });
ok("the accept buttons are reachable", accept > bail, { bail, accept });

// A ceiling must not tell the user to wait for a reset that will never help.
const ceilingCopy = block.slice(block.indexOf("Your models top out"), block.indexOf("btn-accept"));
ok("a ceiling says waiting will not help", /Waiting will not change this/.test(block));
ok("a ceiling offers connecting a stronger model, not waiting",
   /ceiling[\s\S]{0,120}Connect a stronger model/.test(block));
ok("the spent case still offers waiting", /Wait for the reset/.test(block));

// The real roster from this machine: every model low, floor medium.
// classify() is declared BEFORE classifyLocal() and is called by it, so the slice needs both.
const ca = html.indexOf("function classify(id){"), cb = html.indexOf("function isChatModel(");
const classifyLocal = new Function(html.slice(ca, cb) + "\nreturn classifyLocal;")();
const roster = [
  { name: "qwen3:0.6b",       details: { parameter_size: "0.6B" } },
  { name: "llama3.2:3b",      details: { parameter_size: "3.2B" } },
  { name: "qwen3:8b",         details: { parameter_size: "8.2B" } },
];
const tiers = roster.map(m => classifyLocal(m));
ok("an ordinary Ollama roster is entirely low-tier (the trigger)",
   tiers.every(t => t === "low"), tiers);

console.log(fail ? `floor-refusal.test.js: ${pass} passed, ${fail} FAILED`
                 : `floor-refusal.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
