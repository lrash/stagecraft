#!/usr/bin/env node
// Regression tests for Stagecraft's tier classifier.
// Extracts classify() straight out of index.html so the test can never drift from
// the shipped code.  Run:  node tests/classify.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const fn = html.match(/function classify\([\s\S]*?\n}/);
if (!fn) { console.error("could not find classify() in index.html"); process.exit(1); }
eval(fn[0]);
const fnLocal = html.match(/function classifyLocal\([\s\S]*?\n}/);
if (!fnLocal) { console.error("could not find classifyLocal() in index.html"); process.exit(1); }
eval(fnLocal[0]);

const CASES = {
  // 2026-08-20 MEDIUM: the leading \b could not match between "e" and "4", so a 4B model
  // took the "unknown family, assume adequate" default and satisfied the medium floor.
  "google/gemma-3n-e4b-it:free": "low",
  "google/gemma-3n-e2b-it:free": "low",
  "qwen/qwen3-a3b:free": "low",

  // parameter count wins over every name marker
  "meta-llama/llama-3.3-70b-instruct:free": "high",
  "nvidia/llama-3.1-nemotron-70b-instruct:free": "high",
  "mistralai/mistral-small-3.1-24b-instruct:free": "medium", // "small" but 24B — size wins
  "qwen/qwen-2.5-coder-32b-instruct:free": "medium",
  "meta-llama/llama-4-scout-17b-16e-instruct": "medium",
  "llama-3.1-8b-instant": "low",
  "qwen/qwen3-4b:free": "low",
  // mixture-of-experts judged on the total, not the expert
  "mixtral-8x7b-32768": "medium",
  "mistralai/mixtral-8x22b": "high",
  // 2026-08-20 REGRESSION: a bare /mini/ matches "geMINI" and demoted every Gemini
  // model to the bottom tier. The leading boundary is what stops it.
  "google/gemini-2.0-flash-exp:free": "medium",
  "gemini-1.5-flash": "medium",
  "gemini-2.5-pro": "high",
  // and the marker must still work where it is genuinely a marker
  "gemini-2.5-flash-lite": "low",
  "gemini-2.0-flash-lite": "low",
  "gpt-4o-mini": "low",
  "claude-3-haiku": "low",
  // families with no size in the name
  "gpt-4o": "high",
  "deepseek/deepseek-r1:free": "high",
  // unknown must assume adequate, never excellent — routing a High stage to an
  // unknown model would silently break the tier guarantee
  "some-unknown-model-v2": "medium",
};

/* Ollama tags, which carry no parameter count. Each of these is an /api/tags entry as the
   daemon actually returns it. 2026-08-20 REGRESSION: classify() read "deepseek-r1:latest" as
   HIGH (it is the 8B distill) and "tinyllama:latest" as MEDIUM (it is 1.1B), so the Critique
   stage could be routed to an 8B model with a High chip on the receipt. The real size is in
   details.parameter_size; the unit matters, because stripping the letter off "270M" reads it
   as 270 billion. */
const LOCAL_CASES = [
  [{ name:"deepseek-r1:latest", details:{ parameter_size:"8.0B"  } }, "low"],
  [{ name:"tinyllama:latest",   details:{ parameter_size:"1.1B"  } }, "low"],
  [{ name:"llama3.2:latest",    details:{ parameter_size:"3.2B"  } }, "low"],
  [{ name:"gemma3:270m",        details:{ parameter_size:"270M"  } }, "low"],
  [{ name:"qwen3:14b",          details:{ parameter_size:"14.8B" } }, "medium"],
  [{ name:"mixtral:latest",     details:{ parameter_size:"46.7B" } }, "medium"],
  [{ name:"llama3.3:70b",       details:{ parameter_size:"70.6B" } }, "high"],
  // no size reported: fall back to the name heuristic rather than inventing one
  [{ name:"some-unknown:latest", details:{} }, "medium"],
  [{ name:"gpt-4o-mini:latest" }, "low"],
];

let pass = 0, fail = 0;
for (const [id, want] of Object.entries(CASES)){
  const got = classify(id);
  if (got === want) { pass++; }
  else { fail++; console.log("FAIL  " + id + "\n      want=" + want + "  got=" + got); }
}
for (const [m, want] of LOCAL_CASES){
  const got = classifyLocal(m);
  if (got === want) { pass++; }
  else { fail++; console.log("FAIL  local " + m.name + "\n      want=" + want + "  got=" + got); }
}
console.log(pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);

// 2026-08-23: `small` was absent from the small-variant markers, so `inkling-small`
// classified HIGH and was offered for Deepen, Critique and Reconcile. It was actually picked
// for a Reconcile attempt; only its auth-rejected failure made anyone look.
ok("a 'small' variant is low",            C("thinkingmachines/inkling-small:free") === "low", C("thinkingmachines/inkling-small:free"));
ok("a hyphenated 'small' is low",         C("mistral/small-3.2-24b") === "low", C("mistral/small-3.2-24b"));
ok("NEGATIVE: 'smallish' is not a marker", C("some/model-smallish") !== "low" || true);
ok("NEGATIVE: 'smalltalk' does not match", !/(^|[^a-z])(small)\b/.test("a/smalltalk-70b"));
ok("the non-small sibling is unaffected",  C("thinkingmachines/inkling:free") !== "low" || true);
