#!/usr/bin/env node
// Which provider wins the LOW floor.
//
// 2026-08-23, first complete 6-of-6 run: Diverge routed to local/qwen3:0.6b, took 442s on a
// 4-core CPU box, and returned six lines that restated the contract — zero divergence from
// the stage whose whole job is spread. The keyless preference had put a 0.6B model ahead of
// every cloud model, because keyless costs no daily allowance. Conserving quota is worth a
// slower answer; it is not worth a stage that does not do its job.
//   Run:  node tests/low-floor-routing.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const slice = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); return html.slice(i, j); };

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

// A `pref` tweak cannot fix this: the comparator sorts by TIER first, and local models are
// the only ones classifying as `low`, so they precede every cloud model whatever their
// preference. The rule has to remove them from the pool for that floor.
const src = slice("function candidates(floor){", "function pick(floor){");
// `left` is a PARAMETER, not a constant. It was stubbed as () => Infinity, which stubbed away
// the exact variable the 2026-08-23 headroom defect lived in: the filter tested that cloud
// models were LISTED, not that any had quota. A stub that can only express the healthy case
// cannot fail on the unhealthy one.
const harness = (keys, leftFn = '() => Infinity') => `
  const TIERS=["low","medium","high"], rank=t=>TIERS.indexOf(t);
  const SORT_ROOM_CAP=50;
  const PROVIDERS={ local:{keyless:true,name:"Local"}, groq:{keyless:false,name:"Groq"} };
  const S={ keys:${keys},
            models:{ local:[{id:"qwen3:0.6b",tier:"low"}],
                     groq:[{id:"cloud-med",tier:"medium"}] } };
  const DEAD=new Set(); const left=${leftFn};
  // Model-level quota is exercised in tests/model-quota.test.js; here it must be inert so the
  // low-floor rule is what is under test.
  const modelSpent=()=>false;
  const unfitReason=()=>null; const preferScore=()=>0;
  ${src}
  return candidates;
`;
const withCloud = new Function(harness('{local:"local",groq:"k"}'))();
const localOnly = new Function(harness('{local:"local"}'))();

const low = withCloud("low").map(c => c.provider);
ok("local is not offered on the low floor when a cloud model exists", !low.includes("local"), low);
ok("the low floor falls through to an online model",                  low[0] === "groq", low);
// The cheapest ADEQUATE cloud tier for a low floor is medium — the intended outcome.
ok("that online model is a medium-tier one", withCloud("low")[0].tier === "medium", withCloud("low")[0]);

// A preference, not a ban: with no cloud keys the filter must be a no-op.
ok("local still serves the low floor when it is the only provider",
   localOnly("low").map(c=>c.provider)[0] === "local", localOnly("low").map(c=>c.provider));

// Scoped to `low` — medium/high must be untouched.
ok("keyless is untouched off the low floor",
   withCloud("medium").some(c => c.provider === "groq") && withCloud("high").length === 0,
   {med: withCloud("medium").map(c=>c.provider), high: withCloud("high").map(c=>c.provider)});

// The defect: one delivered 429 zeroes a provider's headroom for the window, but it keeps
// listing models. Local must come back exactly then — that is "nowhere else to go".
const cloudSpent = new Function(harness('{local:"local",groq:"k"}', '(p) => p === "groq" ? 0 : Infinity'))();
const spentLow = cloudSpent("low").map(c => c.provider);
ok("a rate-limited cloud provider does not strand the low floor",
   spentLow.includes("local"), spentLow);
ok("local is the choice once cloud headroom is gone",
   spentLow[0] === "local", spentLow);
// And the healthy case must still prefer cloud, or the fix has simply undone the feature.
ok("cloud is still preferred while it has headroom",
   withCloud("low")[0].provider === "groq", withCloud("low").map(c=>c.provider));

console.log(fail ? `low-floor-routing.test.js: ${pass} passed, ${fail} FAILED`
                 : `low-floor-routing.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
