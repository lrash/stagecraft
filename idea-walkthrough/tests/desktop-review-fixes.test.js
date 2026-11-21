#!/usr/bin/env node
// Fixes for the 2026-11-16 review of the desktop v1 work. Each block names the finding.
//   Run:  node tests/desktop-review-fixes.test.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };
const fnSrc = name => {            // a top-level function, by brace matching from its header
  const i = html.indexOf(name); if (i < 0) throw new Error("anchor " + name);
  let d = 0, j = html.indexOf("{", i);
  for (; j < html.length; j++){ if (html[j] === "{") d++; else if (html[j] === "}" && --d === 0) break; }
  return html.slice(i, j + 1);
};

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));
const tests = [];
const test = fn => tests.push(fn);

const REQWEST = "error sending request for url (http://127.0.0.1:11434/api/chat)";

/* ---- a mocked Tauri around the desktop section, as desktop-shell.test.js builds it ---- */
const SECTION = html.slice(html.indexOf("/* ---------- desktop shell (Tauri)"), html.indexOf('const LS = "stagecraft.v1";'));
function tauriCtx(httpFetch, invokeFn){
  class Channel { constructor(){ this.onmessage = null; } }
  const T = {
    core: { invoke: invokeFn || (() => Promise.resolve(null)), Channel },
    http: { fetch: httpFetch },
    event: { listen: () => Promise.resolve(() => {}) },
    dialog: { ask: async () => true }, opener: { openUrl: async () => {} },
  };
  const ctx = vm.createContext({ __TAURI__: T, isTauri: true, __STAGECRAFT_BOOT__: { persistent: true, gen: 1 },
    fetch: () => Promise.resolve("native"), Headers, Request, Response, DOMException, AbortController, setTimeout, clearTimeout, URL, Promise, TypeError });
  vm.runInContext(SECTION, ctx);
  return ctx;
}

/* ---- the whole page still parses (slices can pass while a template elsewhere is broken) ---- */
test(async () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  ok("page: has its inline script", scripts.length >= 1);
  for (const src of scripts){ let err = null; try { new Function(src); } catch (e){ err = e.message; } ok("page: every inline script parses", !err, err); }
});

/* ---- HIGH: a stopped Ollama is "unreachable", not a model error, and sets nothing aside ---- */
test(async () => {
  const ctx = tauriCtx(async url => {
    if (/openrouter/.test(url)) throw new Error("url not allowed on the configured scope: " + url);
    throw REQWEST;                                   // plugin-http rejects with a bare string
  });
  let e1 = null; try { await ctx.fetch("http://127.0.0.1:11434/api/chat", {}); } catch (e){ e1 = e; }
  ok("shim: a reqwest transport error becomes TypeError('Failed to fetch ...')",
     e1 && e1.name === "TypeError" && /^Failed to fetch/.test(e1.message), e1 && String(e1.message || e1));
  ok("shim: ...and keeps reqwest's detail", e1 && e1.message.includes(REQWEST));
  /* R-12 amendment (v2-4, A-18): the cloud URL now reaches cloud_fetch, which the ACL refuses
     while cloud is off; that refusal passes through unchanged. */
  const ctxAcl = tauriCtx(async () => { throw REQWEST; }, async cmd => { if (cmd === "cloud_fetch") throw "Command cloud_fetch not allowed by ACL"; return null; });
  let e2 = null; try { await ctxAcl.fetch("https://openrouter.ai/api/v1/models", {}); } catch (e){ e2 = e; }
  ok("shim: the ACL's refusal passes through unchanged (A-18 reads it)",
     e2 && /not allowed/.test(e2.message) && !/Failed to fetch/.test(e2.message), e2 && e2.message);

  const C = new Function(cut("function classifyAttempt(e){", "function logAttempt(") + cut("const RETIRE = {", "/* ---------- learning when")
    + "\nreturn { classifyAttempt, retireScope };")();
  ok("classify: the shim's error is unreachable", C.classifyAttempt(e1).reason === "unreachable");
  ok("classify: a raw reqwest string is unreachable too", C.classifyAttempt(REQWEST).reason === "unreachable");
  ok("classify: an ordinary model error is still unknown", C.classifyAttempt(new Error("model 'x' not found")).reason === "unknown");

  const run = fnSrc("async function runStage(");
  ok("runStage: desktop local unreachable ends the stage (scope none) instead of markDead",
     /cls\.reason === "unreachable" && c\.provider === "local" && globalThis\.__stagecraftDesktop\) scope = "none"/.test(run));
  ok("runStage: the 'Ollama did not answer' branch tests the shared regex", /const blocked = !!err && classifyAttempt\(err\)\.reason === "unreachable"/.test(run));

  // detectLocal clears local DEAD entries once /api/version answers, and only local ones.
  const DEAD = new Set(["local|qwen3:14b", "local|qwen3:8b", "openrouter|x"]);
  const LOCAL = {}, S = { keys:{}, models:{}, limits:{} };
  const PROVIDERS = { local: { base: "http://127.0.0.1:11434", list: async () => [{ id:"qwen3:14b", tier:"medium" }] } };
  const detect = new Function("DEAD", "LOCAL", "S", "PROVIDERS", "fetchWithTimeout", "readBody", "forgetLocal", "save",
    fnSrc("async function detectLocal(") + "\nreturn detectLocal;")(
    DEAD, LOCAL, S, PROVIDERS, async () => ({ ok: true, status: 200 }), async () => ({ version: "0.40.16" }), () => {}, () => {});
  await detect();
  ok("detectLocal: an answering Ollama clears every local DEAD entry", ![...DEAD].some(k => k.startsWith("local|")), [...DEAD]);
  ok("detectLocal: ...and leaves other providers' entries alone", DEAD.has("openrouter|x"));
  const DEAD2 = new Set(["local|qwen3:14b"]);
  await new Function("DEAD", "LOCAL", "S", "PROVIDERS", "fetchWithTimeout", "readBody", "forgetLocal", "save",
    fnSrc("async function detectLocal(") + "\nreturn detectLocal;")(
    DEAD2, {}, S, PROVIDERS, async () => { throw new TypeError("Failed to fetch"); }, async () => ({}), () => {}, () => {})();
  ok("detectLocal: an Ollama that still does not answer clears nothing", DEAD2.has("local|qwen3:14b"));
});

/* ---- HIGH: Ollama cloud models never join the on-device roster ---- */
test(async () => {
  const SRC = cut("function classify(id){", "/* ---------- providers")
    + "const PROVIDERS = {\n" + cut("  local: {", "  openrouter: {") + "};\n";
  const tags = { models: [
    { name:"qwen3:14b", size:9276198565, details:{ parameter_size:"14.8B" } },
    { name:"qwen3:8b",  size:5225388164, details:{ parameter_size:"8.2B" } },
    { name:"gpt-oss:120b-cloud", size:384, remote_host:"https://ollama.com:443", remote_model:"gpt-oss:120b", details:{ parameter_size:"116.8B" } },
    { name:"deepseek-v3.1:671b-cloud", size:400, details:{ parameter_size:"671B" } },          // tag only
    { name:"kimi-k2:cloud", size:300, details:{ parameter_size:"1T" } },                        // ":cloud" tag
    { name:"mystery:latest", size:500, remote_model:"something", details:{ parameter_size:"70B" } }, // remote field only
    { name:"nomic-embed-text:latest", size:274302450, details:{ parameter_size:"137M" } },
  ] };
  const fetchWithTimeout = async () => ({ ok: true, status: 200, json: async () => tags });
  const M = new Function("fetchWithTimeout", "S", "LOCAL", SRC + "\nreturn { PROVIDERS, isOllamaCloud };")(fetchWithTimeout, {}, { show: {} });
  const roster = await M.PROVIDERS.local.list();
  const ids = roster.map(m => m.id);
  ok("cloud: no remote_host / remote_model / -cloud / :cloud entry reaches the roster",
     JSON.stringify(ids) === JSON.stringify(["qwen3:14b", "qwen3:8b"]), ids);
  ok("cloud: so nothing in the roster tiers high on this box", !roster.some(m => m.tier === "high"));
  ok("cloud: a local model whose name merely contains 'cloud' is kept",
     M.isOllamaCloud({ name:"cloudy-llama:7b" }) === false && M.isOllamaCloud({ name:"wordcloud:latest" }) === false);
});

/* ---- HIGH (a11y): streaming does not flood the answer live region ---- */
test(async () => {
  const els = {}, writes = { out: 0, sr: [] };
  const mk = id => els[id] || (els[id] = { id, _t: "", attrs: {},
    get textContent(){ return this._t; }, set textContent(v){ this._t = v; if (id === "out") writes.out++; if (id === "sr-status") writes.sr.push(v); },
    setAttribute(k, v){ this.attrs[k] = v; }, removeAttribute(k){ delete this.attrs[k]; } });
  let now = 1000;
  const fakeDate = { now: () => now };
  const P = new Function("$", "Date", cut("const PAINT_MS", "async function runStage(") + "\nreturn { showProgress, srSay };")(mk, fakeDate);
  // two seconds of thinking then three seconds of writing at 14 tok/s
  let text = "";
  for (let i = 0; i < 28; i++){ now += 71; P.showProgress({ phase:"thinking", tokens:i, tokPerSec:14 }); }
  for (let i = 0; i < 42; i++){ now += 71; text += "w "; P.showProgress({ phase:"writing", tokens:28+i, tokPerSec:14, text }); }
  P.showProgress({ phase:"done", tokens:70, tokPerSec:14, text });
  ok("stream: #out is repainted at most ~4 times a second, not once per token", writes.out <= 14 && writes.out >= 3, writes.out);
  ok("stream: the final text is painted", els.out.textContent === text);
  ok("stream: only the two phase changes are spoken", writes.sr.length === 2, writes.sr);
  const run = fnSrc("async function runStage(");
  ok("runStage: #out leaves the live set while streaming", /\$\("out"\)\.removeAttribute\("aria-live"\); \$\("out"\)\.setAttribute\("aria-busy", "true"\)/.test(run));
  ok("runStage: ...and returns to it when the run ends", /\$\("out"\)\.removeAttribute\("aria-busy"\); \$\("out"\)\.setAttribute\("aria-live", "polite"\)/.test(run));
  ok("runStage: the finished answer is announced once", /srSay\(s\.name \+ " answer ready, "/.test(run));
  ok("page: #sr-status is a polite status region", /<p class="sr-only" id="sr-status" role="status" aria-live="polite"><\/p>/.test(html));
});

/* ---- MEDIUM: the desktop save reminder never says "saved" unless a save landed (R-11) ---- */
test(async () => {
  const el = { hidden: true, innerHTML: "" };
  const STAGES = [{id:"a"},{id:"b"},{id:"c"},{id:"d"},{id:"e"},{id:"f"}];
  const mk = (SCD) => {
    const G = { __stagecraftDesktop: SCD };
    const S = { outputs: { a:"x", b:"y" }, exportedStages: 0 };
    const f = new Function("globalThis", "$", "S", "STAGES", "exportMd",
      fnSrc("function desktopSaveText(") + fnSrc("function renderSaveReminder(") + "\nreturn renderSaveReminder;")(
      G, id => id === "save-reminder" ? el : null, S, STAGES, () => {});
    f(); return el.innerHTML.replace(/\s+/g, " ");
  };
  const ro = mk({ persistent: false, writeError: null, pending: false, lastSavedAt: null });
  ok("reminder: read-only data dir does not say saved", !/It is saved on this computer/.test(ro) && /cannot save to this computer/.test(ro), ro);
  const full = mk({ persistent: true, writeError: "No space left on device", pending: false, lastSavedAt: 123 });
  ok("reminder: a write error does not say saved", !/It is saved on this computer/.test(full) && /last save to this computer failed/.test(full), full);
  const pend = mk({ persistent: true, writeError: null, pending: true, lastSavedAt: null });
  ok("reminder: a save still pending does not say saved", !/It is saved on this computer/.test(pend), pend);
  const good = mk({ persistent: true, writeError: null, pending: false, lastSavedAt: 123 });
  ok("reminder: a landed save says saved", /It is saved on this computer/.test(good), good);
  ok("reminder: re-rendered whenever Rust reports a save", /onSave = \(\) => \{[^}]*renderSaveReminder\(\)/.test(html));
});

/* ---- MEDIUM: forking on the desktop awaits the save and keeps the way back ---- */
test(async () => {
  const STAGES = [{id:"capture"},{id:"diverge"},{id:"structure"},{id:"deepen"},{id:"critique"},{id:"reconcile"}];
  async function scenario(dialog){
    let resolveDialog;
    const SCD = { saveExport: () => new Promise(res => { resolveDialog = res; }) };
    const env = { notices: "", S: { idea:"old idea", outputs:{ capture:"c", diverge:"d" }, stage:1, exportedStages:0 } };
    const unfork = { onclick: null };
    const $ = id => id === "btn-unfork" ? (env.notices.includes("btn-unfork") ? unfork : null)
                  : id === "input" ? { value: "" } : null;
    const notice = h => { env.notices = h; };     // like the page's: replaces the whole area
    const M = new Function("globalThis", "$", "notice", "STAGES", "esc", "save", "renderAll", "renderSaveReminder", "buildMd", "exportName", "env",
      "let S = env.S;\n" + fnSrc("function sentStages(") + fnSrc("function exportMd(") + fnSrc("async function forkIdea(")
      + "\nreturn { forkIdea, S: () => S };")(
      { __stagecraftDesktop: SCD }, $, notice, STAGES, x => String(x), () => {}, () => {}, () => {}, () => "# md", () => "x.md", env);
    const p = M.forkIdea("a new question");
    await tick();
    const beforeResolve = M.S().outputs.capture;   // still the old run while the dialog is open
    resolveDialog(dialog);
    await p; await tick();
    return { env, unfork, S: M.S(), beforeResolve };
  }
  const tick = () => new Promise(r => setTimeout(r, 0));
  const c = await scenario({ saved: false });
  ok("fork/cancel: the run is not replaced while the dialog is open", c.beforeResolve === "c");
  ok("fork/cancel: the notice still holds 'Bring the previous run back'", c.env.notices.includes("btn-unfork"), c.env.notices);
  ok("fork/cancel: ...and says the previous run was not saved", /not saved<\/b> \(the save was cancelled\)/.test(c.env.notices));
  c.unfork.onclick();
  ok("fork/cancel: the previous run comes back", c.S.outputs.capture === "c" || c.env.S.outputs.capture === "c");
  const s = await scenario({ saved: true, path: "/tmp/x.md" });
  ok("fork/save: the notice names the file and keeps the unfork button",
     s.env.notices.includes("/tmp/x.md") && s.env.notices.includes("btn-unfork"), s.env.notices);
  ok("fork/save: the export is counted against the run it saved", s.S.lastRun && s.S.lastRun.exportedStages === 2, s.S.lastRun);
  ok("fork/save: the new run starts with nothing exported", s.S.exportedStages === 0);
});

/* ---- MEDIUM: Forget everything ends what is in flight and keeps what Ollama reports ---- */
test(async () => {
  const calls = { clear: 0, save: 0, provs: 0, all: 0 };
  const RUN = new AbortController(), PULLac = new AbortController();
  const roster = [{ id:"qwen3:14b", tier:"medium" }];
  const els = { input: { value: "old" }, out: { textContent: "old" }, notices: { innerHTML: "old" } };
  const F = new Function("globalThis", "$", "store", "DEAD", "save", "renderProvs", "renderAll", "env",
    "let RUN = env.RUN, PULL = env.PULL, FORGET_GEN = 0, S = env.S;\n" + fnSrc("async function forgetEverything(")
    + "\nreturn { forgetEverything, S: () => S, gen: () => FORGET_GEN };")(
    { __stagecraftDesktop: { ask: async () => true } }, id => els[id],
    { clear: () => calls.clear++ }, new Set(["local|x"]), () => calls.save++, () => calls.provs++, () => calls.all++,
    { RUN, PULL: { ac: PULLac }, S: { keys:{ local:"local" }, models:{ local: roster }, outputs:{ capture:"secret" }, idea:"secret" } });
  const r = await F.forgetEverything();
  ok("forget: answered yes", r === true);
  ok("forget: aborts the running stage", RUN.signal.aborted);
  ok("forget: aborts a model download", PULLac.signal.aborted);
  ok("forget: bumps the generation in-flight work checks", F.gen() === 1);
  ok("forget: clears the store and saves nothing afterwards (state.json stays deleted)", calls.clear === 1 && calls.save === 0, calls);
  ok("forget: the work is gone", !F.S().idea && !Object.keys(F.S().outputs).length);
  ok("forget: Ollama's roster stays in memory", F.S().keys.local === "local" && F.S().models.local === roster);
  ok("forget: the screen no longer shows the forgotten text", els.input.value === "" && els.out.textContent === "");
  // v2 review: a keychain key Rust could not delete is reported, not "everything was deleted"
  {
    let posted = "";
    const els2 = { input: { value: "x" }, out: { textContent: "x" }, notices: { innerHTML: "" } };
    const SCD = { ask: async () => true, fresh: new Set(),
                  cloud: { on: true, providers: {} },
                  cloudDisable: async () => { SCD.cloud = { on: false, providers: { groq: { enabled: false, present: true, store: "keychain" } } }; return SCD.cloud; } };
    const F2 = new Function("globalThis", "$", "store", "DEAD", "save", "renderProvs", "renderAll", "notice", "esc", "PROVIDERS", "env",
      "let RUN = null, PULL = null, FORGET_GEN = 0, S = env.S;\n" + fnSrc("async function forgetEverything(") + "\nreturn { forgetEverything };")(
      { __stagecraftDesktop: SCD }, id => els2[id], { clear: () => {} }, new Set(), () => {}, () => {}, () => {}, h => { posted = h; }, x => String(x),
      { groq: { name: "Groq" } }, { S: { keys: {}, models: {}, outputs: {} } });
    await F2.forgetEverything();
    ok("forget: a key left in the keychain is named, with what to do", /Your Groq key could not be deleted from your system keychain \(it may be locked\)\. Unlock it, then open Models and use Delete them\./.test(posted), posted);
  }
  const run = fnSrc("async function runStage(");
  ok("runStage: captures the generation when it starts", /const gen = FORGET_GEN;/.test(run));
  ok("runStage: writes nothing after a forget, on success or failure",
     (run.match(/if \(gen !== FORGET_GEN\) return;/g) || []).length >= 2);
  const pull = fnSrc("async function pullModel(");
  ok("pullModel: a forgotten download does not re-detect (and save)", /if \(gen !== FORGET_GEN\)\{[^}]*return;/.test(pull));
});

/* ---- MEDIUM (security): the HTTP scope holds only what the page reads; pulls go through Rust ---- */
test(async () => {
  const cap = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "src-tauri", "capabilities", "main.json"), "utf8"));
  const http = cap.permissions.find(p => p.identifier === "http:default");
  const urls = http.allow.map(a => a.url);
  ok("scope: exactly the five endpoints, no wildcard",
     JSON.stringify(urls) === JSON.stringify(["version","tags","show","ps","chat"].map(p => "http://127.0.0.1:11434/api/" + p)), urls);
  // every Ollama endpoint the page fetches directly is in the scope
  const used = [...new Set([...html.matchAll(/(?:base|PROVIDERS\.local\.base) \+ "\/api\/([a-z]+)"/g)].map(m => m[1]))].sort();
  ok("scope: covers every endpoint the page fetches, and the page no longer fetches /api/pull",
     used.every(p => urls.includes("http://127.0.0.1:11434/api/" + p)) && !used.includes("pull"), used);
  const rs = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "src-tauri", "src", "pull.rs"), "utf8");
  const allowed = JSON.parse("[" + rs.match(/pub const ALLOWED: &\[&str\] = &\[([^\]]*)\]/)[1] + "]");
  const rec = new Function(cut("const LOCAL_RECOMMEND = [", "let PULL") + "\nreturn LOCAL_RECOMMEND;")().map(r => r.id);
  ok("pull: Rust's allow-list is exactly LOCAL_RECOMMEND", JSON.stringify(allowed) === JSON.stringify(rec), { allowed, rec });

  // the shim's pull: invoke with a Channel, progress forwarded, end settles, abort cancels
  const inv = [];
  let ch = null;
  const ctx = tauriCtx(async () => ({ ok: true }), (cmd, args) => { inv.push([cmd, args]); if (cmd === "ollama_pull") ch = args.onEvent; return Promise.resolve(null); });
  const seen = [];
  const p1 = ctx.__stagecraftDesktop.pull("qwen3:8b", m => seen.push(m));
  await new Promise(r => setTimeout(r, 0));
  ok("pull: invokes ollama_pull with the name and a Channel", inv[0][0] === "ollama_pull" && inv[0][1].model === "qwen3:8b" && ch && "onmessage" in ch);
  ch.onmessage({ status: "pulling", total: 10, completed: 5 });
  ch.onmessage({ end: "success" });
  await p1;
  ok("pull: progress reaches the page, then success resolves", seen.length === 1 && seen[0].completed === 5);
  const p2 = ctx.__stagecraftDesktop.pull("qwen3:8b", () => {});
  await new Promise(r => setTimeout(r, 0));
  ch.onmessage({ end: "error", error: "disk full" });
  let e2 = null; try { await p2; } catch (e){ e2 = e; }
  ok("pull: Ollama's error rejects with its text", e2 && e2.message === "disk full");
  const ac = new AbortController();
  const p3 = ctx.__stagecraftDesktop.pull("qwen3:8b", () => {}, ac.signal);
  ac.abort();
  let e3 = null; try { await p3; } catch (e){ e3 = e; }
  ok("pull: abort cancels in Rust and rejects with AbortError",
     e3 && e3.name === "AbortError" && inv.some(([c]) => c === "ollama_pull_cancel"));
});

/* ---- MEDIUM (a11y): warning text and tinted small print meet 4.5:1 in both themes ---- */
test(async () => {
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const block = sel => { const i = css.indexOf(sel); return css.slice(i, css.indexOf("}", i)); };
  const tokens = src => Object.fromEntries([...src.matchAll(/--([a-z0-9-]+):(#[0-9A-Fa-f]{6})/g)].map(m => [m[1], m[2]]));
  const light = tokens(block(":root{")), darkM = tokens(block('@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){')),
        darkA = tokens(block(':root[data-theme="dark"]{'));
  const L = h => { const c = [1,3,5].map(i => parseInt(h.slice(i, i+2), 16) / 255).map(v => v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055) ** 2.4);
                   return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]; };
  const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgs = ["ground", "surface", "surface-2", "low-soft", "warn-soft", "danger-soft"];
  for (const [name, T] of [["light", light], ["dark (media)", darkM], ["dark (attr)", darkA]]){
    const low = bgs.map(b => [b, cr(T["warn-ink"], T[b]).toFixed(2)]).filter(([, r]) => r < 4.5);
    ok(name + ": --warn-ink is >= 4.5:1 on every surface", T["warn-ink"] && !low.length, low);
    const tint = ["low-soft", "warn-soft", "danger-soft"].map(b => [b, cr(T.muted, T[b]).toFixed(2)]).filter(([, r]) => r < 4.5);
    ok(name + ": tinted small print (--muted) is >= 4.5:1", !tint.length, tint);
  }
  ok("warning text no longer uses --warn as a text colour", !/style=\\?"color:var\(--warn\)/.test(html));
  ok("tinted cards and notices remap --faint", /\.prov\.verified, \.notice\.bad, \.notice\.blocked\{--faint:var\(--muted\)\}/.test(css));
});

/* ---- MEDIUM (a11y): re-renders keep focus; the sheet is a real modal ---- */
test(async () => {
  // A tiny DOM: a container whose children are rebuilt by render().
  const doc = { activeElement: null, byId: {} };
  const mkBtn = attrs => ({ attrs, disabled: !!attrs.disabled, hidden: false,
    getAttribute(k){ return this.attrs[k] == null ? null : String(this.attrs[k]); }, focus(){ doc.activeElement = this; } });
  const container = { kids: [], contains(el){ return this.kids.includes(el); },
    querySelector(sel){ const m = sel.match(/^\[([a-z-]+)="(.*)"\]$/); return this.kids.find(k => k.getAttribute(m[1]) === m[2]) || null; } };
  const build = specs => { container.kids = specs.map(mkBtn); doc.byId = {}; container.kids.forEach(k => { if (k.attrs.id) doc.byId[k.attrs.id] = k; }); };
  const document = { get activeElement(){ return doc.activeElement; }, getElementById: id => doc.byId[id] || null };
  const K = new Function("document", fnSrc("function focusKey(") + fnSrc("function keepFocus(") + "\nreturn keepFocus;")(document);

  build([{ id:"btn-local-check" }, { "data-pull":"qwen3:8b" }]);
  doc.activeElement = doc.byId["btn-local-check"];
  K(container, () => build([{ id:"btn-local-check" }, { "data-pull":"qwen3:8b" }]));
  ok("focus: Check again keeps focus across a rebuild", doc.activeElement === doc.byId["btn-local-check"]);

  doc.activeElement = container.kids[1];
  K(container, () => build([{ id:"btn-local-check" }, { id:"btn-pull-cancel" }]), ["btn-pull-cancel", "btn-local-check"]);
  ok("focus: a Pull that turns into a download lands on Cancel", doc.activeElement === doc.byId["btn-pull-cancel"]);

  build([{ "data-i":"0" }, { "data-i":"1" }, { "data-i":"2" }]);
  doc.activeElement = container.kids[2];
  K(container, () => build([{ "data-i":"0" }, { "data-i":"1" }, { "data-i":"2" }]));
  ok("focus: the rail button just chosen keeps focus", doc.activeElement === container.kids[2]);

  // v2 review: the cloud cards' controls carry only data-cloud-* attributes
  for (const a of ["data-cloud-on", "data-cloud-off", "data-cloud-skip", "data-cloud-save", "data-cloud-store", "data-cloud-del"]){
    const v = a === "data-cloud-store" ? "groq:keychain" : "groq";
    build([{ [a]: v }, { "data-i":"0" }]);
    doc.activeElement = container.kids[0];
    K(container, () => build([{ [a]: v }, { "data-i":"0" }]));
    ok("focus: a cloud card's " + a + " control keeps focus across a rebuild", doc.activeElement === container.kids[0]);
  }

  const outside = mkBtn({ id:"input" }); doc.activeElement = outside;
  K(container, () => build([{ "data-i":"0" }]));
  ok("focus: a rebuild never steals focus from outside the container", doc.activeElement === outside);

  ok("rail: the current stage carries aria-current=step", /data-i="\$\{i\}"\$\{state === "current" \? ' aria-current="step"' : ""\}/.test(html));
  ok("sheet: the card is a labelled modal dialog",
     /<div class="card" role="dialog" aria-modal="true" aria-labelledby="sheet-title">/.test(html) && /<h2 id="sheet-title" tabindex="-1">/.test(html));
  const open = cut("window.openSheet = () => {", "window.closeSheet");
  ok("sheet: opening remembers the opener, makes the page inert and moves focus in",
     /SHEET_OPENER = /.test(open) && /el\.inert = true/.test(open) && /\$\("sheet-title"\)\.focus\(\)/.test(open));
  const close = cut("window.closeSheet = () => {", "$(\"btn-setup\").onclick");
  ok("sheet: closing restores the page and returns focus", /el\.inert = false/.test(close) && /back\.focus\(\)/.test(close));
  ok("sheet: every close path goes through closeSheet",
     !/\$\("sheet"\)\.hidden = true; renderAll\(\)/.test(html.replace(close, "")));
});

/* ---- MEDIUM (a11y): a failed pull keeps its reason and is announced ---- */
test(async () => {
  const pull = fnSrc("async function pullModel(");
  ok("pull: no timer removes the failure any more", !/setTimeout/.test(pull));
  ok("pull: failure is spoken through the sheet's alert region, success through its status",
     /sheetSay\("The download of " \+ id \+ " stopped: " \+ finished\.error, true\)/.test(pull) && /sheetSay\(id \+ " is installed\."\)/.test(pull));
  ok("pull: the sheet has its own live regions (the page behind is aria-hidden)",
     /<p class="sr-only" id="sheet-status" role="status" aria-live="polite"><\/p>\s*<p class="sr-only" id="sheet-alert" role="alert"><\/p>/.test(html));
  const tbl = fnSrc("function recommendTable(");
  ok("pull: a failure offers Dismiss and leaves the Pull buttons usable",
     /btn-pull-dismiss/.test(tbl) && /PULL && !PULL\.error \? "disabled"/.test(tbl));
  ok("pull: a finished failure does not block the next pull", /if \(!SCD \|\| \(PULL && !PULL\.error\)\) return;/.test(pull));
});

/* ---- MEDIUM (a11y): the S0 panel says what actually happened ---- */
test(async () => {
  const detectWith = async (fwt) => {
    const LOCAL = {};
    await new Function("DEAD", "LOCAL", "S", "PROVIDERS", "fetchWithTimeout", "readBody", "forgetLocal", "save",
      fnSrc("async function detectLocal(") + "\nreturn detectLocal;")(
      new Set(), LOCAL, { keys:{}, models:{} }, { local: { base: "http://127.0.0.1:11434", list: async () => [] } }, fwt, async () => ({}), () => {}, () => {})();
    return LOCAL;
  };
  const r403 = await detectWith(async () => ({ ok: false, status: 403 }));
  const rTo = await detectWith(async () => { const e = new Error("No answer within 5s. The stage was not completed, but the attempt was probably counted."); e.timedOut = true; throw e; });
  const rDown = await detectWith(async () => { throw new TypeError("Failed to fetch (error sending request)"); });
  ok("S0: a 403 is 'refused'", r403.state === "S0" && r403.why === "refused" && r403.error === "Ollama answered HTTP 403");
  ok("S0: a hang is 'timeout', in plain words, not the stage-run text",
     rTo.why === "timeout" && !/attempt|stage/.test(rTo.error), rTo.error);
  ok("S0: nothing listening is 'down'", rDown.why === "down");

  const els = {};
  const $ = id => id === "provs" ? (els.provs = els.provs || { innerHTML: "" }) : null;
  const render = LOCAL => {
    new Function("globalThis", "$", "S", "LOCAL", "PROVIDERS", "esc", "document", "SYSINFO", "detectLocal", "renderProvs", "renderAll",
      cut("function renderLocalPanel(){", "function recommendTable(") + "\nreturn renderLocalPanel;")(
      { __stagecraftDesktop: { os: "linux", sysInfo: () => Promise.resolve({}) } }, $, { models: {} }, LOCAL,
      { local: { name: "On this computer", base: "http://127.0.0.1:11434" } }, x => String(x), { querySelectorAll: () => [] }, {}, () => {}, () => {}, () => {})();
    return els.provs.innerHTML.replace(/\s+/g, " ");
  };
  const h403 = render(r403);
  ok("S0 panel: a refusal does not also say nothing answered", !/Nothing answered/.test(h403) && /refused Stagecraft/.test(h403), h403);
  const hTo = render(rTo);
  ok("S0 panel: a timeout says so", /did not answer within 5 seconds/.test(hTo) && !/Nothing answered/.test(hTo));
  const hDown = render(Object.assign(rDown, { checks: 2 }));
  ok("S0 panel: nothing listening keeps the install guide", /Nothing answered at/.test(hDown) && /ollama serve/.test(hDown));
  ok("S0 panel: a repeat check says it looked again, with the time", /Still not found at \d\d:\d\d\./.test(hDown), hDown);
});

/* ---- MEDIUM (a11y): Stop is reachable from the keyboard ---- */
test(async () => {
  const run = fnSrc("async function runStage(");
  ok("stop: Run's focus is noted before it is disabled",
     run.indexOf("const keyFocus") > -1 && run.indexOf("const keyFocus") < run.indexOf('$("btn-run").disabled = true'));
  ok("stop: focus moves to Stop and the run is announced",
     /if \(keyFocus\) \$\("btn-stop"\)\.focus\(\);/.test(run) && /Press Stop, or Escape, to cancel/.test(run));
  ok("stop: focus returns to Run when the stage ends", /\$\("btn-run"\)\.focus\(\)/.test(run));
  const keys = cut('document.addEventListener("keydown"', "if (globalThis.__stagecraftDesktop){");
  ok("stop: Escape stops a running local stage when no sheet is open",
     /e\.key === "Escape" && RUN && !\$\("btn-stop"\)\.hidden\)\{ e\.preventDefault\(\); RUN\.abort\(\)/.test(keys)
     && keys.indexOf("window.closeSheet()") < keys.indexOf("RUN.abort()"));
});

/* ---- LOW: desktop failure notices use local-only wording ---- */
test(async () => {
  const run = fnSrc("async function runStage(");
  const tail = run.slice(run.indexOf("const desk = !!globalThis.__stagecraftDesktop"));
  // v2: the allowance sentence shows on the desktop only when a cloud service was tried.
  ok("notice: the allowance sentence is never shown for a desktop run that tried only this computer", /\$\{desk && !cloudTried \? ""/.test(tail));
  const deskTimeout = tail.match(/:\s*desk\s*\?\s*"(Later stages[^"]*)"/);
  ok("notice: the desktop timeout advice names no provider, cloud or allowance",
     deskTimeout && !/provider|cloud|allowance|browser/i.test(deskTimeout[1]), deskTimeout && deskTimeout[1]);
  // v2 review: a failed cloud attempt on the desktop gets cloud advice and says what it cost
  ok("notice (v2): any cloud attempt is tracked", /if \(!PROVIDERS\[c\.provider\]\.keyless\) cloudTried = true;/.test(run));
  ok("notice (v2): the desktop says whether cloud attempts counted against the allowance",
     /: desk \? `<p class="fine" style="margin-top:6px">\$\{counted === 0\n\s*\? "Nothing reached a cloud service, so nothing was counted against its allowance\."/.test(tail)
     && /attempts reached a cloud service and count against its daily allowance\./.test(tail));
  ok("notice (v2): a cloud timeout or error is not told to install a local model",
     /desk && !deskLocal\n\s*\? "Later stages[^"]*A free cloud model this slow is usually overloaded\. Try again later, or run this stage on this computer\."/.test(tail)
     && /desk && !deskLocal \? esc\(lastName\) \+ " had a problem answering\./.test(tail));
});

/* ---- LOW (a11y): the page declares its language (WCAG 3.1.1) ---- */
test(async () => {
  ok("page: <html lang=\"en\"> comes first", /^<html lang="en">\n<meta charset="utf-8">/.test(html));
});

(async () => {
  for (const t of tests){ try { await t(); } catch (e){ fail++; console.log("FAIL  threw: " + (e && e.stack || e)); } }
  console.log(`desktop-review-fixes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
