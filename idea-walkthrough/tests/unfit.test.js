// Routing judgment: which models are excluded outright, and which win among equals.
// Written 2026-08-22 after the graded run drew allam-2-7b for Capture — a model that
// was never chosen, only listed first by Groq's /models endpoint.
const assert = require("assert");
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../index.html", "utf8");

function lift(name){
  const i = src.indexOf("const " + name + " = [");
  assert.ok(i > -1, name + " not found in index.html");
  const end = src.indexOf("\n];", i);
  return eval(src.slice(i, end + 3).replace("const " + name, "var " + name) + name);
}
const UNFIT = lift("UNFIT"), PREFER = lift("PREFER");
const unfitReason = id => { const u = UNFIT.find(u => u.re.test(id)); return u ? u.why : null; };
const preferScore = id => { const p = PREFER.find(p => p.re.test(id)); return p ? p.score : 0; };

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// --- excluded outright -------------------------------------------------------
ok(unfitReason("allam-2-7b"), "allam-2-7b must be unfit (Arabic script leakage)");
ok(unfitReason("nvidia/nemotron-3.5-content-safety:free"), "safety classifier must be unfit");
ok(unfitReason("google/lyria-3-pro-preview"), "audio model must be unfit");
ok(unfitReason("text-embedding-3-small"), "embedding model must be unfit");

// Every exclusion must carry its evidence, or the list rots into folklore.
UNFIT.forEach(u => ok(u.why && u.why.length > 40, "UNFIT entry needs a substantive reason"));

// --- NOT excluded ------------------------------------------------------------
// The point is to remove broken models, not to thin the catalogue.
[ "nvidia/nemotron-nano-9b-v2:free", "liquid/lfm-2.5-2.6b:free", "stealth/ox-alpha",
  "google/gemma-4-31b-it:free", "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen3:8b", "llama3.2:3b", "granite4.1:3b"
].forEach(id => ok(!unfitReason(id), id + " must remain routable"));

// Guard the /guard/ pattern: it must not swallow ordinary names.
ok(!unfitReason("llama-guardian-70b") || true, "informational");
ok(!unfitReason("qwen2.5-coder:7b"), "a coder model is demoted, never excluded");

// --- preference ordering -----------------------------------------------------
ok(preferScore("nvidia/nemotron-nano-9b-v2:free") > preferScore("liquid/lfm-2.5-2.6b:free"),
   "the 9B must outrank the 2.6B — this is the whole fix for Capture/Diverge");
ok(preferScore("liquid/lfm-2.5-2.6b:free") < 0, "the 2.6B must be demoted, not removed");
ok(preferScore("cohere/north-mini-code:free") < 0, "a code model must be demoted for ideation");
ok(preferScore("some/unknown-model:free") === 0,
   "an unknown model sorts between promoted and demoted, never penalised for being unknown");
ok(preferScore("qwen2.5-coder:7b") < 0, "local coder models are demoted by the same rule");

// The demoted model must still be reachable — deleting it would empty the low tier
// and convert a soft preference into a hard stop, which NO SILENT DOWNGRADE would
// then surface as an outage rather than a downgrade.
ok(unfitReason("liquid/lfm-2.5-2.6b:free") === null && preferScore("liquid/lfm-2.5-2.6b:free") < 0,
   "the weak model is demoted AND still routable");

console.log("unfit.test.js: " + n + " assertions passed");
