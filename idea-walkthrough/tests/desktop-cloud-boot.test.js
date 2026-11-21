#!/usr/bin/env node
// DESIGN-desktop v2 review: the opted-in boot's roster re-read (R-96, R-109).
//  - a provider that becomes present only after boot (keys.json confirmed by R-109, a keystore
//    that resolves late) is re-read from the CloudState event, so it routes this session;
//  - a failed re-read is kept and shown (card, pill, ceiling), not wiped by the next render, and
//    the ceiling never blames a spent allowance for it.
//   Run:  node tests/desktop-cloud-boot.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };
const fnSrc = name => {
  const i = html.indexOf(name); if (i < 0) throw new Error("anchor " + name);
  let d = 0, j = html.indexOf("{", i);
  for (; j < html.length; j++){ if (html[j] === "{") d++; else if (html[j] === "}" && --d === 0) break; }
  return html.slice(i, j + 1);
};
let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));
const tick = () => new Promise(r => setTimeout(r, 0));

const CLOUD = cut("/* ---------- desktop v2: opt-in free cloud tiers", "/* The local roster IS its own liveness signal");
const SRC = CLOUD + fnSrc("async function recheck(") + fnSrc("function cloudCeilingHtml(") + fnSrc("function cloudDropped(");

function page(cloud, probe){
  const S = { keys: {}, models: { groq: [{ id: "llama-3.3-70b-versatile", tier: "high" }] }, ledger: {}, limits: {} };
  const SCD = { cloud, fresh: new Set(), allows: p => !!(SCD.cloud.on && SCD.cloud.providers[p] && SCD.cloud.providers[p].enabled && SCD.cloud.providers[p].present) };
  const env = { lists: 0, renders: 0 };
  const PROVIDERS = { openrouter: { name: "OpenRouter" }, gemini: { name: "Google AI Studio" },
    groq: { name: "Groq", list: async () => { env.lists++; if (probe) await probe(); return [{ id: "llama-3.3-70b-versatile", tier: "high" }]; } } };
  const el = () => ({ hidden: true, className: "", textContent: "" });
  const doc = { querySelector: () => null };
  const M = new Function("globalThis", "document", "PROVIDERS", "S", "$", "esc", "save", "renderProvs", "renderGauges", "renderAll", "busy", "sheetSay",
    "left", "cap", "resetsIn", "rank", "TIERS", "used", "modelSpent", "DEAD", "unfitReason", "setReportedLimit", "forgetLocal",
    SRC + "\nreturn { cloudBoot, cloudCatchUp, cloudCardHtml, cloudCeilingHtml, cloudDropped, CLOUD_UI };")(
    { __stagecraftDesktop: SCD }, doc, PROVIDERS, S, el, x => String(x), () => {}, () => {}, () => {}, () => env.renders++, false, () => {},
    () => 200, () => 200, () => "3h 12m", t => ["low", "medium", "high"].indexOf(t), ["low", "medium", "high"],
    () => 0, () => false, new Set(), () => null, () => {}, () => {});
  return { M, S, SCD, env };
}
const st = present => ({ on: true, keystore: "none", scrubbed: [], providers: { groq: { enabled: true, present, store: present ? "file" : "file-unconfirmed" } } });

(async () => {
  {
    const { M, SCD, env } = page(st(false));
    M.CLOUD_UI.booted = true;
    await M.cloudBoot();
    ok("boot: a keys.json key not yet confirmed is not re-read", env.lists === 0 && !SCD.fresh.has("groq"));
    ok("boot: ...so it is dropped from routing", M.cloudDropped("groq", "high") === true);
    SCD.cloud = st(true);                       // Rust's event after "Use it"
    M.cloudCatchUp(); await tick(); await tick();
    ok("event: the CloudState that makes it present re-reads it", env.lists === 1 && SCD.fresh.has("groq"), env);
    ok("event: ...and it routes this session", M.cloudDropped("groq", "high") === false);
    M.cloudCatchUp(); await tick();
    ok("event: a fresh provider is not re-read again", env.lists === 1);
  }
  {
    let release; const gate = () => new Promise(r => { release = r; });
    const { M, env } = page(st(true), gate);
    M.CLOUD_UI.booted = true;
    M.cloudCatchUp(); M.cloudCatchUp(); await tick();
    ok("event: one re-read at a time per provider", env.lists === 1);
    release(); await tick(); await tick();
  }
  {
    const { M } = page(st(true));
    M.cloudCatchUp(); await tick();
    ok("event: nothing is re-read before the boot's own pass has started", M.CLOUD_UI.rechecking.size === 0);
  }
  {
    const { M, SCD } = page(st(true), async () => { throw new Error("HTTP 401 invalid_api_key"); });
    M.CLOUD_UI.booted = true;
    await M.cloudBoot();
    ok("failure: kept for the card, not only written into a DOM node", /^No longer working: HTTP 401 invalid_api_key/.test((M.CLOUD_UI.msg.groq || {}).text) && M.CLOUD_UI.msg.groq.kind === "err", M.CLOUD_UI.msg);
    const card = M.cloudCardHtml("groq", SCD.cloud);
    ok("failure: the pill says not working, not the cached model count", /pill[^>]*>not working</.test(card) && !/1 models/.test(card), card);
    ok("failure: the card shows why", /No longer working: HTTP 401/.test(card));
    const ceil = M.cloudCeilingHtml({ floor: "high" });
    ok("failure: the ceiling says it is not working, and does not blame the allowance",
       /Groq is not working \(HTTP 401 invalid_api_key\)\. Check it in Models, or replace its key\./.test(ceil) && !/allowance left/.test(ceil), ceil);
  }
  {
    const { M, SCD } = page(st(true));
    SCD.fresh.add("groq");
    const ceil = M.cloudCeilingHtml({ floor: "high" });
    ok("spent: a fresh provider with nothing left still gets the allowance wording", /No free cloud model at HIGH has allowance left; Groq resets soonest, in 3h 12m\./.test(ceil) && !/not working/.test(ceil), ceil);
    ok("pill: a fresh roster shows its count", /1 models/.test(M.cloudCardHtml("groq", SCD.cloud)));
  }
  console.log(fail ? `desktop-cloud-boot.test.js: ${pass} passed, ${fail} FAILED` : `desktop-cloud-boot.test.js: ${pass} assertions passed`);
  process.exit(fail ? 1 : 0);
})();
