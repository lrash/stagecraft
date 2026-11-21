#!/usr/bin/env node
// DESIGN-desktop v2-5 (A-57 unit half): local first, cloud fills floor gaps (R-96, R-102, R-107, D-28).
//   Run:  node tests/desktop-routing.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const SRC = cut("const SORT_ROOM_CAP", "function pick(floor){").replace(/const STAGES = \[[\s\S]*?\n\];/, "");
const STAGES = [["capture", "medium"], ["diverge", "low"], ["structure", "medium"], ["deepen", "high"], ["critique", "high"], ["reconcile", "high"]];
// §5.1: this box's roster, as classifyLocal tiers it
const LOCAL = [{ id: "qwen3:14b", tier: "medium", params: 14.8 }, { id: "gemma3:12b", tier: "medium", params: 12.2 },
               { id: "qwen3:8b", tier: "low", params: 8.2 }, { id: "qwen2.5-coder:7b", tier: "low", params: 7.6 }, { id: "llama3.2:3b", tier: "low", params: 3.2 }];
const MOCK = { groq: [{ id: "llama-3.3-70b-versatile", tier: "high" }, { id: "qwen-2.5-32b", tier: "medium" }, { id: "llama-3.1-8b-instant", tier: "low" }],
               openrouter: [{ id: "mock/llama-3.3-70b-instruct:free", tier: "high" }, { id: "mock/qwen-2.5-14b-instruct:free", tier: "medium" }] };
const PROVIDERS = { local: { keyless: true, name: "On this computer", dailyLimit: Infinity }, groq: { name: "Groq", dailyLimit: 200 },
                    openrouter: { name: "OpenRouter", dailyLimit: 50 }, gemini: { name: "Google AI Studio", dailyLimit: 50 } };

function router(S, desk){
  const g = desk === undefined ? {} : { __stagecraftDesktop: desk };
  return new Function("globalThis", "S", "PROVIDERS", "DEAD", "left", "modelSpent",
    `const TIERS=["low","medium","high"], rank=t=>TIERS.indexOf(t);\n` + SRC + "\nreturn { candidates, floorCoverage };")(
    g, S, PROVIDERS, new Set(), p => PROVIDERS[p].dailyLimit, () => false);
}
const desk = (on, fresh) => ({ allows: p => p === "local" || (on && ["groq", "openrouter"].includes(p)), fresh: new Set(fresh || ["groq", "openrouter"]) });
const base = extra => Object.assign({ keys: { local: "local", groq: "keychain", openrouter: "keychain" },
  models: { local: LOCAL, groq: MOCK.groq, openrouter: MOCK.openrouter }, localInstalled: LOCAL.map(m => ({ id: m.id, tier: m.tier })) }, extra || {});
const first = (R, floor) => { const c = R.candidates(floor)[0]; return c ? c.provider + "/" + c.id : null; };
const where = R => STAGES.map(([id, f]) => id + ":" + (R.candidates(f).length ? R.candidates(f)[0].provider : "none"));

{
  const R = router(base(), desk(true));
  ok("gaps: Capture, Diverge and Structure stay local; the three high stages go to cloud high",
     JSON.stringify(where(R)) === JSON.stringify(["capture:local", "diverge:local", "structure:local", "deepen:groq", "critique:groq", "reconcile:groq"]), where(R));
  ok("gaps: a covered floor has no cloud entry at all (dropped before ranking)",
     R.candidates("low").every(c => c.provider === "local") && R.candidates("medium").every(c => c.provider === "local"));
  ok("gaps: the high stages get the high tier, not a lower cloud model", R.candidates("high").every(c => c.tier === "high"));
  ok("gaps: the cheapest free high model with the most headroom wins (Groq 200 > OpenRouter 50)", first(R, "high") === "groq/llama-3.3-70b-versatile", first(R, "high"));
}
{
  const S = base(); delete S.models.local; delete S.keys.local;
  const R = router(S, desk(true));
  ok("gaps: with Ollama stopped (S.models.local gone) but the installed roster kept, covered floors still never go to cloud",
     R.candidates("low").length === 0 && R.candidates("medium").length === 0 && first(R, "high") === "groq/llama-3.3-70b-versatile");
  const S2 = base({ localInstalled: [] }); delete S2.models.local; delete S2.keys.local;
  ok("gaps: nothing installed at all, so every floor may use cloud", router(S2, desk(true)).candidates("medium")[0].provider !== "local");
}
{
  const S = base({ cloudRoute: "best" });
  const R = router(S, desk(true));
  const browser = router(base(), undefined);           // the browser ranks everything together
  const ids = (X, f) => X.candidates(f).map(c => c.provider + "/" + c.id).join();
  ok("best: matches the browser ranking on every floor", ["low", "medium", "high"].every(f => ids(R, f) === ids(browser, f)),
     ["low", "medium", "high"].map(f => [ids(R, f), ids(browser, f)]));
  ok("best: so the low-floor online-pool rule pulls Diverge to a cloud model", R.candidates("low")[0].provider !== "local");
}
{
  ok("cloud off: no cloud entry", router(base(), desk(false)).candidates("high").every(c => c.provider === "local"));
  ok("localOnly: no cloud entry, on any floor", ["low", "medium", "high"].every(f => router(base({ localOnly: true, cloudRoute: "best" }), desk(true)).candidates(f).every(c => c.provider === "local")));
  ok("an opted-in boot: a provider whose roster was not re-read has no candidates", router(base(), desk(true, ["openrouter"])).candidates("high").every(c => c.provider !== "groq"));
  const S = base(); S.models.openrouter = [{ id: "mock/paid-70b", tier: "high", paid: true }];
  ok("R-104: a paid model is never a candidate", !router(S, desk(true)).candidates("high").some(c => c.id === "mock/paid-70b"));
  // v2 review: list() admits a model priced only per request; the shim's record keeps it out.
  const S2 = base({ cloudRoute: "best" });
  S2.models.openrouter = [{ id: "mock/hermes-3-8b-request:free", tier: "low" }, { id: "mock/llama-3.2-3b-instruct:free", tier: "low" }];
  const d2 = Object.assign(desk(true), { isPaid: (p, id) => p === "openrouter" && id === "mock/hermes-3-8b-request:free" });
  const low = router(S2, d2).candidates("low").map(c => c.id);
  ok("R-104: a request-priced OpenRouter model is never chosen, even in best mode on a low floor",
     !low.includes("mock/hermes-3-8b-request:free") && low.includes("mock/llama-3.2-3b-instruct:free"), low);
}
{
  const rs = cut("async function runStage(", "/* ---------- local-only copy");
  ok("R-104: Rust's not-allowed on an OpenRouter chat sets that model aside and falls over",
     /if \(cls\.reason === "gate-refused" && e\.gateRefused === "not-allowed" && c\.provider === "openrouter"\) scope = "session";/.test(rs));
}
{
  // R-107: detectLocal writes the installed roster only on a successful list; forgetLocal keeps it.
  const det = cut("async function detectLocal(){", "/* What the desktop self-test may drive.");
  ok("R-107: detectLocal stores S.localInstalled from a successful /api/tags", /S\.localInstalled = models\.map\(m => \(\{ id: m\.id, tier: m\.tier \}\)\);/.test(det));
  ok("R-107: forgetLocal does not clear it", !/localInstalled/.test(cut("function forgetLocal(){", "\n")));
}
console.log(fail ? `desktop-routing.test.js: ${pass} passed, ${fail} FAILED` : `desktop-routing.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
