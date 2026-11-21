// Free-access filtering and observed reliability.
//
// A sweep on 2026-08-22 called all 22 free OpenRouter models: 15 answered, 7 did not.
// Of the 19 a user is offered after filtering, SIX were broken — about a third of the
// list. That is what "the model list is too busy" actually meant.
const assert = require("assert");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");

// Boundaries are the declaration that starts the block and the function that follows it —
// both stable. An earlier version anchored on a comment that turned out to sit BEFORE the
// block rather than after it.
const from = html.indexOf("const UNFIT = [");
const to = html.indexOf("function candidates(floor){", from);
assert.ok(from > -1 && to > from, "reliability block not found");
const M = new Function(html.slice(from, to) +
  "\nreturn { unfitReason, preferScore, preferWhy, OBSERVED_2026_08_22, PREFER };")();

let n = 0, bad = 0;
const ok = (m, c, x) => { if (c) n++; else { bad++; console.log("FAIL  " + m + (x !== undefined ? "  [" + JSON.stringify(x) + "]" : "")); } };

// --- free means free on BOTH sides --------------------------------------------
// A model free to send to and billed for what it says back is not free, and the reply is
// always the larger half.
const listFn = html.slice(html.indexOf('https://openrouter.ai/api/v1/models'), html.indexOf("async chat", html.indexOf('https://openrouter.ai/api/v1/models')));
ok("prompt price is checked", /pricing\.prompt\) === 0/.test(listFn));
ok("completion price is checked too", /pricing\.completion\) === 0/.test(listFn));
ok("the :free suffix is no longer the authority", !/endsWith\(":free"\)/.test(listFn));

// --- every confirmed-broken model is demoted ----------------------------------
[ "thinkingmachines/inkling:free", "thinkingmachines/inkling-small:free",
  "z-ai/glm-5.2:free", "poolside/laguna-s-2.1:free",
  "google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
].forEach(id => ok(id + " is demoted", M.preferScore(id) < 0, M.preferScore(id)));

// --- but NOT excluded ---------------------------------------------------------
// These are one account's observations. inkling is gated behind a plan this key lacks;
// another user's key may have it. An exclusion would ship one person's entitlements as
// everyone's limits.
[ "thinkingmachines/inkling:free", "z-ai/glm-5.2:free", "google/gemma-4-31b-it:free"
].forEach(id => ok(id + " remains routable", M.unfitReason(id) === null));

// --- every model that ANSWERED sorts at or above zero -------------------------
[ "nvidia/nemotron-nano-9b-v2:free", "stealth/ox-alpha", "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free", "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-nano-30b-a3b:free", "poolside/laguna-xs-2.1:free",
  "nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-nano-12b-v2-vl:free"
].forEach(id => ok(id + " is not demoted", M.preferScore(id) >= 0, M.preferScore(id)));

// --- a measurement must beat an assumption ------------------------------------
// A +2 for the gemma-4 family once sat in PREFER on reputation. Summed against the
// demotion the sweep earned, it cancelled out and put a broken model back in mid-list.
ok("no a-priori promotion survives for gemma", !M.PREFER.some(p => /gemma/i.test(String(p.re))));
ok("gemma-4-31b ends up net negative", M.preferScore("google/gemma-4-31b-it:free") < 0);
ok("gemma-4-26b ends up more negative than 31b",
   M.preferScore("google/gemma-4-26b-a4b-it:free") < M.preferScore("google/gemma-4-31b-it:free"));

// --- an intermittent model is treated more gently than a dead one -------------
ok("intermittent beats consistently-failing",
   M.preferScore("google/gemma-4-31b-it:free") > M.preferScore("z-ai/glm-5.2:free"));
ok("a capacity error is treated as recoverable",
   M.preferScore("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free") > M.preferScore("z-ai/glm-5.2:free"));

// --- every observation carries its evidence ------------------------------------
M.OBSERVED_2026_08_22.forEach(o => ok("observation has a reason", o.why && o.why.length > 15, o.why));
ok("the reason is retrievable for the UI", /observed 2026-08-22/.test(M.preferWhy("z-ai/glm-5.2:free")));
ok("an unknown model is not penalised", M.preferScore("some/brand-new-model:free") === 0);

console.log((bad ? "FAILED " : "") + n + " assertions passed" + (bad ? ", " + bad + " failed" : ""));
process.exit(bad ? 1 : 0);
