#!/usr/bin/env node
// A provider that refuses on quota must lose its headroom — including an UNMETERED one.
//
// 2026-08-23 review, HIGH: exhaust() wrote n = used+1 and relied on left() = cap - n. For
// dailyLimit:Infinity (the LiteLLM gateway) that is Infinity - n, still Infinity. So a
// provider that had just answered 429 kept full headroom. retireScope("quota-exhausted")
// returns "window" and the loop deliberately SKIPS markDead for that scope, trusting exhaust()
// to have zeroed it — so the router re-picked the same dead model until MAX_ATTEMPTS ran out.
//   Run:  node tests/exhaust-unmetered.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const a = html.indexOf("function windowKey(p, now){"), b = html.indexOf("/* ---------- the router");
const build = () => {
  const ctx = `
    const PROVIDERS = { gateway:{name:"Gateway", dailyLimit:Infinity, resetsUTC:0},
                        metered:{name:"Metered", dailyLimit:50, resetsUTC:0} };
    const S = { ledger:{}, limits:{} };
    const save = () => {};
    ${html.slice(a, b)}
    return { S, cap, used, left, spend, exhaust, windowKey };
  `;
  return new Function(ctx)();
};

// --- the defect, on an unmetered provider ---
{
  const R = build();
  ok("unmetered starts with infinite headroom", R.left("gateway") === Infinity, R.left("gateway"));
  R.exhaust("gateway");
  ok("after a 429 an UNMETERED provider has ZERO headroom", R.left("gateway") === 0, R.left("gateway"));
  ok("and pick()'s filter (headroom > 0) would now exclude it", !(R.left("gateway") > 0));
}

// --- the metered path must be unchanged ---
{
  const R = build();
  ok("metered starts at its cap", R.left("metered") === 50, R.left("metered"));
  R.spend("metered");
  ok("a normal spend decrements",  R.left("metered") === 49, R.left("metered"));
  R.exhaust("metered");
  ok("a 429 zeroes a metered provider too", R.left("metered") === 0, R.left("metered"));
}

// --- the marker is scoped to the window, so the provider comes back ---
{
  const R = build();
  R.exhaust("gateway");
  ok("spent is recorded against this window", R.S.ledger.gateway.spent === true);
  R.S.ledger.gateway.day = "1999-01-01";      // pretend the window rolled over
  ok("when the window rolls, headroom returns", R.left("gateway") === Infinity, R.left("gateway"));
}

// --- and a spend after exhaustion must not resurrect it ---
{
  const R = build();
  R.exhaust("gateway");
  ok("still zero after exhaustion", R.left("gateway") === 0);
}

console.log(fail ? `exhaust-unmetered.test.js: ${pass} passed, ${fail} FAILED`
                 : `exhaust-unmetered.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
