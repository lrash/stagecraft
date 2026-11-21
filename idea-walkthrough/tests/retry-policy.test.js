// Retirement policy, reset learning, and allowance drift.
//
// The commonest failure by far is a daily cap, and a capped model is asleep, not broken.
// Before this, every failure retired a model for the whole session — so a model that ran
// out at 09:00 stayed unusable after its own reset.
const assert = require("assert");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");

const from = html.indexOf("const RETIRE = {");
// Boundary is the comment that follows the policy block. Do not anchor on a declaration —
// the last boundary moved when a helper was relocated, and the test broke for no real reason.
const to = html.indexOf('/* Sort headroom is CLAMPED', from);
assert.ok(from > -1 && to > from, "policy block not found");

let S = { resetObs:{}, capObs:{}, ledger:{} };
const PROVIDERS = { groq:{dailyLimit:200}, openrouter:{dailyLimit:50}, local:{dailyLimit:Infinity} };
const save = () => {};
const M = new Function("S","PROVIDERS","save",
  html.slice(from, to) +
  "\nreturn { retireScope, noteExhausted, noteRecovered, resetEstimate, noteObservedCap, allowanceDrift, weeklyAllowanceCheck };"
)(S, PROVIDERS, save);

let n = 0, bad = 0;
const ok = (m, c, extra) => { if (c) n++; else { bad++; console.log("FAIL  " + m + (extra !== undefined ? "  [" + JSON.stringify(extra) + "]" : "")); } };

// --- scopes -------------------------------------------------------------------
ok("a daily cap retires only for the window", M.retireScope("quota-exhausted") === "window");
ok("a bad key retires for the session",       M.retireScope("auth-rejected") === "session");
ok("an unreachable host retires for the session", M.retireScope("unreachable") === "session");
ok("a timeout is retried once",               M.retireScope("timeout") === "retry");
ok("a cut-off reply is retried once",         M.retireScope("truncated") === "retry");
ok("a 5xx is retried once",                   M.retireScope("http-500") === "retry");
ok("a 4xx is not retried",                    M.retireScope("http-400") === "session");
ok("unknown is treated conservatively",       M.retireScope("unknown") === "session");
// The whole point: the commonest failure must NOT be the harshest response.
ok("a cap is never session-fatal", M.retireScope("quota-exhausted") !== "session");

// --- the loop must honour it --------------------------------------------------
ok("window scope skips markDead", /if \(scope !== "window"\) markDead\(c\)/.test(html));
ok("retry reuses the same model once", /retriedOnce\.has\(deadKey\(c\)\)/.test(html));

// --- reset learning: a 429 then a success brackets the reset ------------------
const H = h => Date.UTC(2026, 7, 20, h, 0, 0);
M.noteExhausted("groq", H(2)); M.noteRecovered("groq", H(7));
let est = M.resetEstimate("groq");
ok("one observation gives a band", est && est.lowUTC === 2 && est.highUTC === 7, est);

// A second, tighter observation must NARROW it, never widen it.
M.noteExhausted("groq", Date.UTC(2026,7,21,3,0,0)); M.noteRecovered("groq", Date.UTC(2026,7,21,5,0,0));
est = M.resetEstimate("groq");
ok("a tighter observation narrows the band", est.lowUTC === 3 && est.highUTC === 5, est);
ok("sample count is reported", est.samples === 2, est);

// A gap longer than a day could contain another whole reset, so it constrains nothing.
M.noteExhausted("openrouter", H(1)); M.noteRecovered("openrouter", H(1) + 30*3600e3);
ok("a >24h gap is discarded", M.resetEstimate("openrouter") === null, M.resetEstimate("openrouter"));

// Nothing is claimed before evidence exists.
ok("no observations means no estimate", M.resetEstimate("local") === null);

// --- allowance drift ----------------------------------------------------------
S.capObs = {};
M.noteObservedCap("openrouter", 20, "2026-08-20");
ok("one sample is an anecdote, not drift", M.allowanceDrift().length === 0);
M.noteObservedCap("openrouter", 20, "2026-08-20");
ok("the same window is not counted twice", (S.capObs.openrouter || []).length === 1);
M.noteObservedCap("openrouter", 24, "2026-08-21");
const drift = M.allowanceDrift();
ok("two samples disagreeing with config is drift", drift.length === 1, drift);
ok("drift reports configured and observed",
   drift[0] && drift[0].configured === 50 && drift[0].observed === 24, drift[0]);

// Matching config is not drift.
S.capObs = {};
M.noteObservedCap("groq", 200, "2026-08-20"); M.noteObservedCap("groq", 200, "2026-08-21");
ok("agreement is not reported as drift", M.allowanceDrift().length === 0);

// --- the weekly cadence -------------------------------------------------------
S.allowanceCheckedAt = null;
ok("the first check runs", M.weeklyAllowanceCheck(Date.now()) !== null);
ok("a second check the same day does not", M.weeklyAllowanceCheck(Date.now()) === null);
ok("a check runs again after a week", M.weeklyAllowanceCheck(Date.now() + 8*24*3600e3) !== null);

console.log((bad ? "FAILED " : "") + n + " assertions passed" + (bad ? ", " + bad + " failed" : ""));
process.exit(bad ? 1 : 0);
