#!/usr/bin/env node
// DESIGN-desktop steps 9, 10 and 14: local-only routing and what the desktop says about it.
//   A-19 floorCoverage on this box's roster is exactly the §5.1 table, "3 of 7" (PROPOSAL 2026-11-17: Review added)
//   A-18 a provider the build does not allow never routes, even with a key and models in S
//   A-20 (unit half) the local ceiling copy names the model and never a cloud provider
//   A-26 below-floor provenance reaches the next stage's context; RAM-fit warns, except for a
//        model /api/ps lists as resident
//   A-29 receipts are rebuilt from fields; stored HTML and model output never become markup
//   A-16 (unit half) external links go to the opener, the window never navigates
//   Run:  node tests/desktop-local.test.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const STAGES = new Function(cut("const STAGES = [", "const stage = () =>") + "\nreturn STAGES;")();

/* ---- the router, as router.test.js lifts it ---- */
const ROUTER = cut('const TIERS = ["low","medium","high"];', "\n\n// Heuristic:")
  + cut("function windowKey(p, now){", "/* ---------- the router")
  + cut("const DEAD = new Set();", "/* ---------- the six stages");
const build = new Function("S", "PROVIDERS", "save", "STAGES", ROUTER +
  "\nreturn { candidates, pick, rankCandidates, floorCoverage, DEAD };");
const PROVIDERS = {
  local:      { name:"On this computer", keyless:true, dailyLimit:Infinity, resetsUTC:0 },
  openrouter: { name:"OpenRouter", dailyLimit:50, resetsUTC:0 },
};
// This box on 2026-11-16 (DESIGN §5.1), in /api/tags order.
const ROSTER = [
  { id:"gemma3:12b",       tier:"low",    params:11.8, size:8164039732 },
  { id:"qwen2.5-coder:7b", tier:"low",    params:7.6,  size:4683087561 },
  { id:"qwen3:14b",        tier:"medium", params:14.8, size:9276198565 },
  { id:"qwen3:8b",         tier:"low",    params:8.2,  size:5225388164 },
  { id:"llama3.2:3b",      tier:"low",    params:3.2,  size:2019393189 },
];

{
  const S = { keys:{ local:"local" }, models:{ local: ROSTER }, ledger:{}, limits:{}, mledger:{} };
  const R = build(S, PROVIDERS, () => {}, STAGES);
  const cov = R.floorCoverage(ROSTER);
  const got = cov.map(c => [c.stage, c.best && c.best.id, c.meetsFloor]);
  const want = [["capture","qwen3:14b",true],["diverge","gemma3:12b",true],["structure","qwen3:14b",true],
                ["deepen","qwen3:14b",false],["critique","qwen3:14b",false],["reconcile","qwen3:14b",false],
                ["review","qwen3:14b",false],["verify","qwen3:14b",false]];   // PROPOSAL 2026-11-17; Check facts 2026-11-18
  ok("A-19: floorCoverage is exactly the §5.1 table", JSON.stringify(got) === JSON.stringify(want), got);
  ok("A-19: 3 of 8 stages run at their floor", cov.filter(c => c.meetsFloor).length === 3 && cov.length === 8);
  ok("the below-floor best carries its real tier", cov[3].best.tier === "medium" && cov[3].floor === "high");
  ok("Diverge's tiebreak is params, not listing order", R.candidates("low")[0].id === "gemma3:12b", R.candidates("low").map(c => c.id));
  const reversed = build({ keys:{ local:"local" }, models:{ local: ROSTER.slice().reverse() }, ledger:{}, limits:{}, mledger:{} }, PROVIDERS, () => {}, STAGES);
  ok("...and the same whatever order /api/tags lists them in",
     JSON.stringify(reversed.candidates("low").map(c => c.id)) === JSON.stringify(R.candidates("low").map(c => c.id)));
  ok("the coder model still sorts last among the lows (PREFER -2)",
     R.candidates("low").filter(c => c.tier === "low").slice(-1)[0].id === "qwen2.5-coder:7b");
  ok("an empty roster covers nothing", R.floorCoverage([]).every(c => c.best === null && !c.meetsFloor));
  ok("candidates() and floorCoverage() agree at every floor", STAGES.every((st, i) => {
       const c = R.candidates(st.floor)[0]; return cov[i].meetsFloor ? c && c.id === cov[i].best.id : !c; }));
}

/* ---- A-18: the build's allow-list beats a planted key ---- */
{
  const S = { keys:{ local:"local", openrouter:"sk-or-v1-planted" },
              models:{ local: ROSTER, openrouter:[{ id:"meta-llama/llama-3.3-70b-instruct:free", tier:"high" }] },
              ledger:{}, limits:{}, mledger:{} };
  const R = build(S, PROVIDERS, () => {}, STAGES);
  ok("in a browser a connected cloud key routes as before", R.pick("high").ok && R.pick("high").choice.provider === "openrouter");
  globalThis.__stagecraftDesktop = { allows: id => id === "local" };
  try {
    ok("in the desktop it is never a candidate", ["low","medium","high"].every(f => R.candidates(f).every(c => c.provider === "local")));
    const p = R.pick("high");
    ok("...so a high stage hits the local ceiling instead", !p.ok && p.exhausted.length === 0 && p.fallback && p.fallback.id === "qwen3:14b", p);
  } finally { delete globalThis.__stagecraftDesktop; }
}

/* ---- A-20: local ceiling copy ---- */
{
  const src = cut("const SHALLOWER = {", "/* S.autoLower was a one-way latch:");
  const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const M = new Function("esc", "LOCAL", src + "\nreturn { localCeilingHtml, localNoModelHtml };")(esc, { state:"S2" });
  const crit = STAGES.find(s => s.id === "critique");
  const h = M.localCeilingHtml(crit, { id:"qwen3:14b", tier:"medium" });
  ok("the ceiling names the stage, the floor and the strongest model",
     /Critique needs a HIGH model\. Your strongest is qwen3:14b \(MEDIUM\)\./.test(h), h);
  ok("...says nothing has been sent", /Nothing has been sent/.test(h));
  ok("...and what running it anyway costs", /shallower objections than this stage is designed for/.test(h));
  ok("...offers run-anyway, always-below-floor and a stronger local model",
     /id="btn-accept"/.test(h) && /id="btn-accept-always"/.test(h) && /Always run below floor, and keep telling me/.test(h) && /data-action="open-local-models"/.test(h));
  const cloud = /OpenRouter|cloud|free tier|API key|Get a free key|browser|this address|serve from localhost/i;
  ok("...and never mentions a cloud provider", !cloud.test(h));
  ok("the nothing-installed copy is local too", !cloud.test(M.localNoModelHtml(crit)) && /Nothing has been sent/.test(M.localNoModelHtml(crit)));
  const rs = cut("  const res = forced ? { ok:true, choice:forced } : pick(s.floor);", 'busy = true; $("btn-run").disabled = true;');
  ok("the desktop branch is an extra branch: the browser's tested strings stay in place",
     /Your models top out/.test(rs) && /Waiting will not change this/.test(rs) && /Wait for the reset/.test(rs)
     && rs.indexOf("nothingConnected ||") < rs.indexOf("res.fallback && S.autoLower")
     && rs.indexOf("res.fallback && S.autoLower") < rs.indexOf('id="btn-accept"'));
  ok("the ceiling branch is taken only in the desktop", /if \(ceiling && globalThis\.__stagecraftDesktop\) notice\(localCeilingHtml\(s, res\.fallback\), "blocked"\);\s*else notice\(/.test(rs));
  ok("nothing is sent until a click: both accept buttons are wired after the notice",
     /\$\("btn-accept"\)\.onclick = \(\) => runStage\(res\.fallback\);/.test(rs));
}

/* ---- A-26: provenance downstream ---- */
{
  const DEMOTE = cut("function demoteHeadings(s){", "function exportName(){");
  const CTX = cut("const contextSoFar = (stage) => {", "/* ---------- rendering");
  const S = { stage: 4, outputs: { capture:"C", diverge:"D", structure:"St", deepen:"Dp",
              "deepen:floor": { floor:"high", ran:"medium", model:"qwen3:14b" } } };
  const ctx = new Function("STAGES", "S", DEMOTE + CTX + "\nreturn contextSoFar;")(STAGES, S);
  const c = ctx(STAGES[4]);
  ok("a forced Deepen is labelled BELOW its floor in Critique's context",
     /## Deepen\n_ANALYSIS[^\n]* — produced BELOW its high floor by qwen3:14b \(medium\)_/.test(c), c.slice(-300));
  ok("...and only Deepen is", (c.match(/BELOW its/g) || []).length === 1);
  delete S.outputs["deepen:floor"];
  ok("a later non-forced Deepen success (which deletes :floor) removes it", !/BELOW its/.test(ctx(STAGES[4])));
  const rs = cut("async function runStage(", "window.stopAutoLower");
  ok("runStage sets :floor when forced and deletes it otherwise",
     /if \(forced\) S\.outputs\[s\.id \+ ":floor"\] = \{ floor: s\.floor, ran: c\.tier, model: c\.id \};\s*else delete S\.outputs\[s\.id \+ ":floor"\];/.test(rs));
  ok("the export carries the same line under the stage heading", /floorNote\(s\.id\)/.test(cut("function buildMd(){", "function exportMd(")));
  ok("R-4 still holds: s.status is stamped in exactly one place",
     html.split("\n").filter(l => /(^|[^A-Za-z0-9_])s\.status/.test(l)).length === 1);   // grep -c counts lines
}

/* ---- A-26: RAM fit ---- */
(async () => {
  const src = cut("/* ---------- resource fit (R-65)", "/* Receipt metrics (R-64)")
            + cut("const REPLY_RESERVE", "/* Reasoning models emit");
  const mk = (resident, availMb) => {
    const fetchWithTimeout = async url => ({ ok: true, json: async () => ({ models: resident ? [{ name: "qwen3:8b" }] : [] }) });
    const LOCAL = { show: { "qwen3:8b": { ok:true, ctxMax: 40960, blocks:36, kvHeads:8, keyLen:128, valLen:128 } } };
    return new Function("fetchWithTimeout", "LOCAL", "PROVIDERS", src + "\nreturn { ramFitNote, ramFitText };")(
      fetchWithTimeout, LOCAL, { local: { base: "http://127.0.0.1:11434" } });
  };
  const c = { provider:"local", id:"qwen3:8b", size: 5225388164 };
  globalThis.__stagecraftDesktop = { sysInfo: async () => ({ totalMb: 19775, availMb: 3000 }) };
  try {
    const warn = await mk(false).ramFitNote(c);
    ok("a model larger than free memory is disclosed", /may not fit in free memory \(needs ~7\.1 GB, 2\.9 GB free\)/.test(warn), warn);
    ok("a model /api/ps lists as loaded is not", (await mk(true).ramFitNote(c)) === "");
    globalThis.__stagecraftDesktop.sysInfo = async () => ({ totalMb: 19775, availMb: 12000 });
    ok("nor is one that fits", (await mk(false).ramFitNote(c)) === "");
    ok("a cloud model is never checked", (await mk(false).ramFitNote({ provider:"groq", id:"x" })) === "");
  } finally { delete globalThis.__stagecraftDesktop; }
  ok("the browser never checks (no desktop)", (await mk(false).ramFitNote(c)) === "");

  /* ---- A-29: receipts ---- */
  {
    const esc = s => String(s).replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
    const R = new Function("esc", "PROVIDERS", "S", cut("function fmtMs(ms){", '/* ---------- "save your work"') +
      "\nreturn { receiptHtml, receiptText };")(esc, { local: { name: "On this computer" } }, { autoLower: false });
    const evil = { tier:"low", model:'x"><img src=x onerror=alert(1)>', provider:"local", left:"no limit", floor:"high",
                   forced:true, auto:false, failed:1, metrics:{ evalCount: 12, tokPerSec: 3.2, firstChunkMs: 4000, wallMs: 65000 } };
    const h = R.receiptHtml(evil);
    ok("a hostile model id is escaped in the rebuilt receipt", !/<img/.test(h) && /&lt;img/.test(h), h);
    ok("the receipt shows the run's metrics", /12 tokens · 3\.2 tok\/s · first words after 4s · 1m 5s in all/.test(h), h);
    ok("...and a forced run says so", /below this stage's high floor, at your request/.test(h));
    ok("the export text has no markup", !/[<>]/.test(R.receiptText({ ...evil, model: "qwen3:8b" })));
    const rsr = cut("function renderStage(){", '/* ---------- "save your work"');
    ok("a stored HTML receipt is never written back as markup",
       /else if \(legacy\) \$\("receipt"\)\.textContent = /.test(rsr) && !/innerHTML = r;/.test(rsr));
    ok("model output reaches #out only as text", /\$\("out"\)\.textContent = S\.outputs\[s\.id\]/.test(rsr)
       && /\$\("out"\)\.textContent = p\.text/.test(html));
  }

  /* ---- A-16: external links (the section's listener) ---- */
  {
    const SECTION = cut("/* ---------- desktop shell (Tauri)", 'const LS = "stagecraft.v1";');
    let handler = null; const opened = [];
    const document = { addEventListener: (ev, fn, cap) => { if (ev === "click" && cap) handler = fn; }, createElement: () => ({ style:{} }) };
    const ctx = vm.createContext({ document, isTauri: true, __STAGECRAFT_BOOT__: {}, Headers, URL, setTimeout, clearTimeout, Promise,
      fetch: () => Promise.resolve(), location: { href: "tauri://localhost/index.html", protocol: "tauri:", host: "localhost", origin: "tauri://localhost" },
      __TAURI__: { core: { invoke: async () => null }, event: { listen: async () => {} }, http: { fetch: async () => {} },
                   dialog: { ask: async () => true }, opener: { openUrl: async u => { opened.push(u); } } } });
    vm.runInContext(SECTION, ctx);
    const click = (href, target) => { let prevented = false;
      const a = { getAttribute: k => k === "href" ? href : target, after: () => {} };
      handler({ target: { closest: () => a }, preventDefault: () => { prevented = true; } }); return prevented; };
    ok("a target=_blank link is intercepted", click("https://ollama.com/download", "_blank") === true);
    ok("a plain external link is intercepted", click("https://ollama.com/library") === true);
    await new Promise(r => setTimeout(r, 5));
    ok("...and both go to the system browser", opened.join(" ") === "https://ollama.com/download https://ollama.com/library", opened);
    ok("an in-page #anchor is left alone", click("#top") === false);
    ok("a same-origin link is left alone", click("tauri://localhost/index.html") === false);
  }

  console.log(fail ? `desktop-local.test.js: ${pass} passed, ${fail} FAILED`
                   : `desktop-local.test.js: ${pass} assertions passed`);
  process.exit(fail ? 1 : 0);
})();
