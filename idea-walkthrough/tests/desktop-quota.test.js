#!/usr/bin/env node
// DESIGN-desktop v2-7 (A-60): the quota panel's pure view (R-100).
//   Run:  node tests/desktop-quota.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };
let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const LEDGER = cut("function windowKey(p, now){", "/* ---------- the router");
const Q = cut("/* ---------- R-100: the quota panel", "function cloudQuotaLine(p){");
const PROVIDERS = { local: { keyless: true, name: "On this computer", dailyLimit: Infinity, resetsUTC: 0 },
                    groq: { name: "Groq", dailyLimit: 200, resetsUTC: 0 }, openrouter: { name: "OpenRouter", dailyLimit: 50, resetsUTC: 0 },
                    gemini: { name: "Google AI Studio", dailyLimit: 50, resetsTZ: "America/Los_Angeles", resetsUTC: 8 }, litellm: { name: "Gateway", dailyLimit: Infinity, resetsUTC: 0 } };
function make(S, dead){
  return new Function("S", "PROVIDERS", "DEAD", "unfitReason", "save", "globalThis", "esc",
    LEDGER + Q + "\nreturn { quotaView, quotaRowText, resetsIn, msToZoneMidnight };")(
    S, PROVIDERS, new Set(dead || []), id => /broken/.test(id) ? "known broken" : null, () => {}, {}, x => String(x));
}
const now = Date.UTC(2026, 10, 16, 20, 48);
const day = p => make({ ledger: {}, limits: {}, mledger: {} }).quotaView; // not used
{
  const S = { keys: { local: "local", groq: "keychain", openrouter: "keychain", gemini: "keychain" },
              models: { local: [{ id: "qwen3:14b", tier: "medium" }],
                        groq: [{ id: "g-high-70b", tier: "high" }, { id: "g-high2-70b", tier: "high" }, { id: "g-med-32b", tier: "medium" }, { id: "g-low-8b", tier: "low" }, { id: "broken-1", tier: "low" }],
                        openrouter: [{ id: "o-70b:free", tier: "high" }, { id: "o-paid-405b", tier: "high", paid: true }],
                        gemini: [{ id: "gemini-2.5-pro", tier: "high" }] },
              ledger: {}, limits: {}, mledger: {} };
  const M0 = make(S);
  const wk = new Function("S", "PROVIDERS", LEDGER + "\nreturn windowKey;")(S, PROVIDERS);
  S.ledger.groq = { day: wk("groq"), n: 153 };
  S.mledger["groq|g-high2-70b"] = { day: wk("groq") };
  for (const m of S.models.gemini) S.mledger["gemini|" + m.id] = { day: wk("gemini") };
  const M = make(S, ["groq|g-med-32b"]);
  const v = Object.fromEntries(M.quotaView(now).map(x => [x.provider, x]));
  ok("A-60: a spent model is in resting, not tiers", v.groq.tiers.high === 1 && v.groq.resting.some(m => m.id === "g-high2-70b"), v.groq);
  ok("A-60: DEAD and unfit models are not available", v.groq.tiers.medium === 0 && v.groq.tiers.low === 1);
  ok("A-60: used/cap/left come from the ledger, estimated", v.groq.used === 153 && v.groq.cap === 200 && v.groq.left === 47 && v.groq.estimated === true);
  ok("A-60: allModelsSpent -> left 0", v.gemini.left === 0);
  ok("A-60: gemini uses resetsTZ", v.gemini.resetsIn === M.resetsIn("gemini", now) && M.msToZoneMidnight("America/Los_Angeles", now) > 0
     && v.gemini.resetsIn !== new Function("S", "PROVIDERS", LEDGER + "\nreturn resetsIn;")(S, Object.assign({}, PROVIDERS, { gemini: { resetsUTC: 0, dailyLimit: 50 } }))("gemini", now), v.gemini.resetsIn);
  ok("A-60: a paid OpenRouter model is not counted", v.openrouter.tiers.high === 1 && !v.openrouter.resting.length);
  ok("A-60: the gateway never appears", !("litellm" in v));
  ok("A-60: the row reads as designed", M.quotaRowText(v.groq) === "Groq · about 47 of 200 left today (our count) · resets in " + v.groq.resetsIn + " · HIGH 1 · MEDIUM 0 · LOW 1", M.quotaRowText(v.groq));
  ok("A-60: a spent provider is resting", /^Google AI Studio · Resting until its reset, in /.test(M.quotaRowText(v.gemini)));
  ok("A-60: local has no daily limit", M.quotaRowText(v.local) === "On this computer · no daily limit");
}
console.log(fail ? `desktop-quota.test.js: ${pass} passed, ${fail} FAILED` : `desktop-quota.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
