#!/usr/bin/env node
// DESIGN-desktop v2-4 (§13.3, §13.2): the page's side of opt-in cloud use.
//  A-55: cloud URLs go to invoke("cloud_fetch") with no headers, never to plugin-http; an abort
//        calls cloud_fetch_cancel and rejects with AbortError; each R-106 row gives its outcome,
//        RETIRE scope and spend; the Ollama path and the provider code are unchanged.
//  R-82: the cloud-off allow-list is exactly the strings §13.1 names.
//  R-86 (D-29): the guided key setup, with a mocked invoke.
//   Run:  node tests/desktop-cloud.test.js
const fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const SECTION = cut("/* ---------- desktop shell (Tauri)", 'const LS = "stagecraft.v1";');
function tauriCtx(onInvoke, boot){
  const calls = { http: [], invoke: [], listen: {} };
  const T = {
    core: { invoke: (cmd, args) => { calls.invoke.push([cmd, args]); return onInvoke(cmd, args); }, Channel: class {} },
    http: { fetch: async (url, init) => { calls.http.push({ url, init }); return { ok: true, status: 200, url }; } },
    event: { listen: (ev, fn) => { calls.listen[ev] = fn; return Promise.resolve(() => {}); } },
    dialog: { ask: async () => true }, opener: { openUrl: async () => {} },
  };
  const ctx = vm.createContext({ __TAURI__: T, isTauri: true, __STAGECRAFT_BOOT__: Object.assign({ persistent: true, gen: 1 }, boot || {}),
    fetch: () => Promise.resolve("native"), Headers, Request, Response, DOMException, AbortController, setTimeout, clearTimeout, URL, Promise, TypeError });
  vm.runInContext(SECTION, ctx);
  return { ctx, SCD: ctx.__stagecraftDesktop, calls };
}
const PAGE = cut("function classifyAttempt(e){", "function logAttempt(") + cut("const RETIRE = {", "/* ---------- learning when")
  + cut("const DEFAULT_TIMEOUT_MS", "/* A timeout is NOT a transport error.") + cut("function timeoutFail(ms){", "/* Parse the body WITHOUT");

const ON = { on: true, keystore: "keychain", scrubbed: [],
             providers: { openrouter: { enabled: true, present: true, store: "keychain" }, groq: { enabled: true, present: true, store: "session" },
                          gemini: { enabled: false, present: true, store: "keychain" } } };

(async () => {
  /* ---- A-55: routing in the shim ---- */
  {
    const { ctx, calls } = tauriCtx(async (cmd, a) => cmd === "cloud_fetch"
      ? { status: 200, headers: [["content-type", "application/json"], ["x-ratelimit-remaining-requests", "9"]], body: '{"data":[{"id":"m"}]}' }
      : null);
    const r = await ctx.fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: "Bearer keychain", "X-Probe": "1" } });
    const cf = calls.invoke.find(c => c[0] === "cloud_fetch");
    ok("A-55: a cloud URL reaches invoke('cloud_fetch')", !!cf && calls.http.length === 0, calls);
    ok("A-55: ...as provider, method and path, with no page headers and no marker",
       cf && cf[1].provider === "groq" && cf[1].method === "GET" && cf[1].path === "/openai/v1/models" && !("headers" in cf[1])
       && !/keychain|X-Probe/i.test(JSON.stringify(cf[1])), cf && cf[1]);
    ok("A-55: ...and a reply is a Response with Rust's status, body and headers",
       r.status === 200 && (await r.json()).data[0].id === "m" && r.headers.get("x-ratelimit-remaining-requests") === "9");
    await ctx.fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent", { method: "POST", body: '{"contents":[]}' });
    const g = calls.invoke.filter(c => c[0] === "cloud_fetch").pop();
    ok("A-55: a POST carries its body as text", g[1].provider === "gemini" && g[1].method === "POST" && g[1].body === '{"contents":[]}'
       && g[1].path === "/v1beta/models/gemini-2.5-pro:generateContent", g[1]);
    await ctx.fetch("https://openrouter.ai/api/v1/models?x=1");
    ok("A-55: a query is passed through, so Rust can refuse it", calls.invoke.filter(c => c[0] === "cloud_fetch").pop()[1].path === "/api/v1/models?x=1");
    const ids = calls.invoke.filter(c => c[0] === "cloud_fetch").map(c => c[1].reqId);
    ok("A-55: reqIds come from a per-window counter", ids.join() === "1,2,3", ids);
    await ctx.fetch("http://127.0.0.1:11434/api/tags");
    ok("A-55: the Ollama path is unchanged (plugin-http, empty Origin)",
       calls.http.length === 1 && calls.http[0].init.headers.get("Origin") === "" && calls.http[0].init.maxRedirections === 0);
  }
  /* ---- R-104 (v2 review): the shim marks every OpenRouter model Rust would refuse ---- */
  {
    const mockModels = require("./fixtures/mock-cloud.js").MODELS.openrouter;
    const { ctx, SCD } = tauriCtx(async cmd => cmd === "cloud_fetch" ? { status: 200, headers: [], body: JSON.stringify({ data: mockModels }) } : null);
    await (await ctx.fetch("https://openrouter.ai/api/v1/models")).text();
    ok("R-104: a model priced only per request is paid by Rust's rule; fully free ones are not",
       SCD.isPaid("openrouter", "mock/hermes-3-8b-request:free") && SCD.isPaid("openrouter", "mock/llama-3.1-405b-instruct")
       && !SCD.isPaid("openrouter", "mock/llama-3.2-3b-instruct:free") && !SCD.isPaid("groq", "mock/hermes-3-8b-request:free"), [...SCD.openrouterPaid]);
    await (await ctx.fetch("https://openrouter.ai/api/v1/models", {})).text();
    const M = new Function("globalThis", cut("function markPaid(", "function cloudSay(") + "\nreturn markPaid;")({ __stagecraftDesktop: SCD });
    const ms = M("openrouter", [{ id: "mock/hermes-3-8b-request:free", tier: "low" }, { id: "mock/llama-3.2-3b-instruct:free", tier: "low" }]);
    ok("R-104: markPaid flags it in the stored roster", ms[0].paid === true && !ms[1].paid);
  }
  /* ---- A-55: abort ---- */
  {
    let release;
    const { ctx, calls } = tauriCtx((cmd) => cmd === "cloud_fetch" ? new Promise(r => { release = r; }) : Promise.resolve(true));
    const ac = new AbortController();
    const p = ctx.fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", body: "{}", signal: ac.signal });
    await tick(); ac.abort();
    let e = null; try { await p; } catch (x){ e = x; }
    const cancel = calls.invoke.find(c => c[0] === "cloud_fetch_cancel");
    ok("A-55: an abort rejects with AbortError", e && e.name === "AbortError", e && e.name);
    ok("A-55: ...and cancels the same request in Rust", cancel && cancel[1].reqId === calls.invoke[0][1].reqId, calls.invoke);
    release({ status: 200, body: "late" });
    const ac2 = new AbortController(); ac2.abort();
    let e2 = null; try { await ctx.fetch("https://api.groq.com/openai/v1/models", { signal: ac2.signal }); } catch (x){ e2 = x; }
    ok("A-55: an already-aborted signal sends nothing", e2 && e2.name === "AbortError" && calls.invoke.filter(c => c[0] === "cloud_fetch").length === 1);
  }
  /* ---- A-55: one case per R-106 row ---- */
  {
    const C = new Function("fetch", PAGE + "\nreturn { classifyAttempt, retireScope, fetchWithTimeout };");
    const rows = [
      ["unreachable", "unreachable", "session", false],
      ["timeout", "timeout", "retry", true],
      ["cancelled:sent", "stopped", "none", true],
      ["cancelled:unsent", "stopped", "none", false],
      ["cloud-off", "stopped", "none", false],
      ["not-enabled", "stopped", "none", false],
      ["no-key", "gate-refused", "none", false],
      ["not-allowed", "gate-refused", "none", false],
      ["too-large", "gate-refused", "none", false],
      ["reply-too-large:200", "reply-too-large", "session", true],
      ["interrupted:200", "interrupted", "retry", true],
    ];
    for (const [code, reason, scope, counted] of rows){
      const { ctx } = tauriCtx(cmd => cmd === "cloud_fetch" ? Promise.reject(code) : Promise.resolve(null));
      const M = C(ctx.fetch);
      let e = null; try { await M.fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", { method: "POST", body: "{}" }, 5000); } catch (x){ e = x; }
      const cls = e && M.classifyAttempt(e);
      ok("R-106 " + code + ": " + reason + " / " + scope + " / " + (counted ? "counted" : "not counted"),
         cls && cls.reason === reason && M.retireScope(cls.reason) === scope && !!e.delivered === counted,
         e && { reason: cls.reason, scope: M.retireScope(cls.reason), delivered: !!e.delivered, msg: e.message });
      if (code === "cancelled:sent") ok("R-106: the stopped error is not an AbortError, so fetchWithTimeout passes it through", e.name !== "AbortError" && e.stopped === true && !e.timedOut);
      if (/^(no-key|not-allowed|too-large)$/.test(code)) ok("R-106: gate-refused keeps its code for the notice", e.gateRefused === code);
      if (/:200$/.test(code)) ok("R-106: " + code + " keeps the status and is not a gate refusal", e.status === 200 && !e.gateRefused && !/Nothing was sent/.test(e.message), e.message);
    }
    const { ctx } = tauriCtx(cmd => cmd === "cloud_fetch" ? Promise.reject("Command cloud_fetch not allowed by ACL") : null);
    let e = null; try { await ctx.fetch("https://openrouter.ai/api/v1/models"); } catch (x){ e = x; }
    ok("R-106: the ACL's own refusal (cloud off) passes through as itself", e && /not allowed by ACL/.test(e.message) && !e.gateRefused && !e.stopped);
    ok("classify: OpenRouter's data-policy 404 is its own reason, retire none",
       C(null).classifyAttempt(Object.assign(new Error("No endpoints found matching your data policy (Free model training)"), { delivered: true, status: 404 })).reason === "data-policy"
       && C(null).retireScope("data-policy") === "none");
  }
  /* ---- R-110: SCD.cloud and allows() ---- */
  {
    const { SCD, calls } = tauriCtx(async (cmd, a) => cmd === "cloud_provider_set"
      ? Object.assign({}, ON, { providers: Object.assign({}, ON.providers, { groq: { enabled: a.enabled, present: true, store: "session" } }) }) : ON, { cloud: ON });
    ok("allows: local always", SCD.allows("local") === true);
    ok("allows: on + enabled + present", SCD.allows("openrouter") === true && SCD.allows("groq") === true);
    ok("allows: a provider that is not enabled is not allowed", SCD.allows("gemini") === false);
    ok("allows: an unknown id never is", SCD.allows("litellm") === false && SCD.allows("__proto__") === false);
    await SCD.providerSet("groq", false);
    ok("allows: follows every reply, not the boot copy", SCD.allows("groq") === false);
    calls.listen["stagecraft://cloud"]({ payload: { on: false, keystore: "keychain", providers: ON.providers, scrubbed: [] } });
    ok("allows: follows the stagecraft://cloud event", SCD.allows("openrouter") === false && SCD.cloud.on === false);
    calls.listen["stagecraft://cloud"]({ payload: { on: true } });
    ok("allows: a malformed event is ignored", SCD.cloud.on === false);
    const off = tauriCtx(async () => null).SCD;
    ok("allows: with no boot cloud field (v1 Rust) nothing but local", off.allows("openrouter") === false && off.cloud.on === false);
    ok("the boot field's scrubbed ids and opted-in launch are kept", tauriCtx(async () => null, { cloud: Object.assign({}, ON, { scrubbed: ["groq"] }) }).SCD.scrubbed[0] === "groq"
       && tauriCtx(async () => null, { cloud: ON }).SCD.bootCloudOn === true);
  }
  /* ---- D-4 (v2 review): a replaced window's sent requests reach the new page's ledger ---- */
  {
    ok("D-4: the boot object's cloudUnrecorded is kept", tauriCtx(async () => null, { cloudUnrecorded: { groq: 1 } }).SCD.unrecorded.groq === 1
       && JSON.stringify(tauriCtx(async () => null).SCD.unrecorded) === "{}");
    const boot = cut("const _desk = globalThis.__stagecraftDesktop;", "detectLocal().then(");
    ok("D-4: each is spent once (and recorded as sent) before anything routes", /for \(let i = 0; i < n; i\+\+\)\{ noteSent\(p, \(\(typeof stage === "function" \? stage\(\) : STAGES\[S\.stage\]\) \|\| \{\}\)\.id\); spend\(p\); \}/.test(boot)
       && /if \(!PROVIDERS\[p\] \|\| PROVIDERS\[p\]\.keyless\) continue;/.test(boot));
  }
  /* ---- R-12: the provider objects are byte-identical to v1 ---- */
  {
    const a = html.indexOf("const PROVIDERS = {"), b = html.indexOf("/* ---------- local model facts");
    // Re-pinned for the public release: the only change from 2abe2c9 is the example hostname in one comment.
    ok("R-12: PROVIDERS is unchanged from v1 (sha256 pinned at 2abe2c9, comment re-pinned for release)",
       crypto.createHash("sha256").update(html.slice(a, b)).digest("hex") === "0057b5d4f2cf34c4b046b479b41e71a0fb0cc0965dee6a9187419ca2046b2bb5");
  }
  /* ---- R-82: the cloud-off allow-list ---- */
  const CLOUD = cut("/* ---------- desktop v2: opt-in free cloud tiers", "/* The local roster IS its own liveness signal");
  {
    const PROVIDERS = { openrouter: { name: "OpenRouter" }, groq: { name: "Groq" }, gemini: { name: "Google AI Studio" } };
    const L = new Function("PROVIDERS", CLOUD + "\nreturn { CLOUD_OFF_ALLOW, CLOUD_SWITCH, CLOUD_OPT_IN_LINK };")(PROVIDERS);
    ok("R-82: the switch, its hint, the ceiling link, the R-87 key line and [Delete them], nothing else",
       L.CLOUD_OFF_ALLOW[0] === "Use free cloud models" && L.CLOUD_OFF_ALLOW[2] === "Use a free cloud tier"
       && L.CLOUD_OFF_ALLOW.includes("Cloud is off.") && L.CLOUD_OFF_ALLOW.includes("Delete them")
       && L.CLOUD_OFF_ALLOW.includes("Your OpenRouter key is still in your system keychain.")
       && L.CLOUD_OFF_ALLOW.includes("Your Groq key is kept until Stagecraft closes.")
       && L.CLOUD_OFF_ALLOW.length === 5 + 3 * 3, L.CLOUD_OFF_ALLOW);
    ok("R-82: the hint says no one 'needs' cloud", !/need/i.test(L.CLOUD_OFF_ALLOW[1]));
  }
  /* ---- R-86 (D-29): the guided key setup with a mocked invoke ---- */
  {
    const els = {};
    const el = id => els[id] || (els[id] = { id, value: "", innerHTML: "", hidden: false, textContent: "" });
    const env = { kc: null, secretCalls: [], listCalls: [], renders: 0 };
    const S = { keys: {}, models: {}, ledger: {}, limits: {} };
    const SCD = {
      cloud: { on: true, keystore: "keychain", scrubbed: [], providers: { groq: { enabled: true, present: false, store: null } } },
      fresh: new Set(),
      secretSet: async (p, v, st) => { env.secretCalls.push([p, v, st]); return env.kc; },
    };
    const PROVIDERS = { openrouter: { name: "OpenRouter" }, gemini: { name: "Google AI Studio" },
      groq: { name: "Groq", signup: "https://console.groq.com/keys",
              list: async k => { env.listCalls.push(k); return [{ id: "a", tier: "high" }, { id: "b", tier: "low" }]; } } };
    const M = new Function("globalThis", "PROVIDERS", "S", "$", "esc", "save", "renderProvs", "renderGauges", "renderAll", "busy", "sheetSay", "recheck",
      "left", "cap", "resetsIn", "rank", "TIERS", "used", "modelSpent", "DEAD", "unfitReason",
      CLOUD + "\nreturn { cloudSaveKey, cloudCardHtml, CLOUD_UI };")(
      { __stagecraftDesktop: SCD }, PROVIDERS, S, el, x => String(x), () => {}, () => env.renders++, () => {}, () => {}, false, () => {}, async () => {},
      () => 200, () => 200, () => "3h 12m", t => ["low", "medium", "high"].indexOf(t), ["low", "medium", "high"],
      () => 0, () => false, new Set(), () => null);
    el("cloud-key-groq").value = "  test-only-groq-0011223344556677 ";
    env.kc = { stored: true, status: "ok", store: "keychain", httpStatus: 200 };
    await M.cloudSaveKey("groq", null);
    ok("setup: secret_set gets the trimmed value first", env.secretCalls[0][1] === "test-only-groq-0011223344556677" && env.secretCalls[0][2] === null);
    ok("setup: the field is cleared", el("cloud-key-groq").value === "");
    ok("setup: then the marker, never the key, is kept", S.keys.groq === "keychain" && !JSON.stringify(S).includes("test-only"));
    ok("setup: then the roster is listed through the shim with the marker", env.listCalls[0] === "keychain" && S.models.groq.length === 2 && SCD.fresh.has("groq"));
    ok("setup: ok says what connected", /Connected: 2 free models; best tier HIGH\. Key saved in your system keychain\./.test(M.CLOUD_UI.msg.groq.text), M.CLOUD_UI.msg.groq);
    for (const [kc, re] of [[{ status: "rejected" }, /^Groq did not accept that key\. Nothing was saved\.$/],
                            [{ status: "error", httpStatus: 500 }, /^Groq answered HTTP 500\. Nothing was saved\.$/],
                            [{ status: "unreachable" }, /did not answer\. Nothing was saved/],
                            [{ status: "rate-limited" }, /Nothing was saved/]]){
      el("cloud-key-groq").value = "test-only-groq-x1234567"; env.kc = kc; S.keys = {};
      await M.cloudSaveKey("groq", null);
      ok("setup: " + kc.status + " is worded and stores nothing", re.test(M.CLOUD_UI.msg.groq.text) && !S.keys.groq && el("cloud-key-groq").value === "", M.CLOUD_UI.msg.groq);
    }
    for (const [code, re] of [["not-allowed", /^That does not look like a Groq key \(it must be one piece of text with no spaces\)\. Copy it again from Groq's Keys page\. Nothing was saved\.$/],
                              ["cloud-off", /^Cloud use or Groq was turned off, so nothing was saved\.$/], ["not-enabled", /^Cloud use or Groq was turned off/]]){
      const keep = SCD.secretSet;
      SCD.secretSet = async () => { throw code; };          // a Tauri command's Err(String) rejects with the bare string
      el("cloud-key-groq").value = "Bearer gsk_abcdefgh"; S.keys = {};
      await M.cloudSaveKey("groq", null);
      SCD.secretSet = keep;
      ok("setup: Rust's Err " + code + " is worded", re.test(M.CLOUD_UI.msg.groq.text) && !S.keys.groq, M.CLOUD_UI.msg.groq);
    }
    el("cloud-key-groq").value = "test-only-groq-nokeystore"; env.kc = { stored: false, status: "no-keystore" };
    await M.cloudSaveKey("groq", null);
    const card = M.cloudCardHtml("groq", SCD.cloud);
    ok("setup: with no keychain it offers the session and the file, session first",
       /no system keychain running/.test(card) && card.indexOf("Use this key until Stagecraft closes") < card.indexOf("Save it unencrypted on this computer"), card);
    env.kc = { stored: true, status: "ok", store: "session" }; env.secretCalls.length = 0;
    await M.cloudSaveKey("groq", "session");
    ok("setup: the choice re-sends the held key with store:'session', once", env.secretCalls.length === 1 && env.secretCalls[0][1] === "test-only-groq-nokeystore"
       && env.secretCalls[0][2] === "session" && !M.CLOUD_UI.pending.groq);
    el("cloud-key-groq").value = "test-only-groq-locked1"; env.kc = { stored: false, status: "locked" };
    await M.cloudSaveKey("groq", null);
    const lc = M.cloudCardHtml("groq", SCD.cloud);
    ok("setup: a locked keychain offers Try again and the session, no file", /it may be locked/.test(lc) && /Try again/.test(lc) && !/unencrypted on this computer/.test(lc));
    const off = M.cloudCardHtml("openrouter", { on: true, providers: {} });
    ok("setup step 0: a card that is off offers only its own Turn on (and Skip) while its setup is open",
       (M.CLOUD_UI.setup = "openrouter", /data-cloud-on="openrouter"/.test(M.cloudCardHtml("openrouter", { on: true, providers: {} }))) && !/cloud-key-openrouter/.test(M.cloudCardHtml("openrouter", { on: true, providers: {} })), off);
    M.CLOUD_UI.setup = null;
    const gem = M.cloudCardHtml("gemini", { on: true, providers: { gemini: { enabled: true, present: false } } });
    ok("setup: Gemini says it needs a Google account and warns about billing", /Google account required, no card/.test(gem) && /without billing/.test(gem));
    const orc = M.cloudCardHtml("openrouter", { on: true, providers: { openrouter: { enabled: true, present: false } } });
    ok("setup: OpenRouter names the data-policy setting", /Settings → Privacy/.test(orc));
  }
  /* ---- v2 review: with cloud off, [Delete them] shows its result; a failure says why ---- */
  {
    const SCD = { cloud: { on: false, keystore: "unknown", scrubbed: [], providers: { groq: { enabled: false, present: true, store: "keychain" }, gemini: { enabled: false, present: true, store: "keychain" } } },
                  fresh: new Set(), secretDelete: async p => { if (p === "groq") throw "locked"; SCD.cloud.providers[p] = { enabled: false, present: false, store: null }; return SCD.cloud; } };
    const PROVIDERS = { openrouter: { name: "OpenRouter" }, groq: { name: "Groq" }, gemini: { name: "Google AI Studio" } };
    const M = new Function("globalThis", "PROVIDERS", "S", "$", "esc", "save", "renderProvs", "renderGauges", "renderAll", "busy", "sheetSay", "recheck",
      "left", "cap", "resetsIn", "rank", "TIERS", "used", "modelSpent", "DEAD", "unfitReason",
      CLOUD + "\nreturn { cloudDeleteAll, cloudPanelHtml, CLOUD_UI };")(
      { __stagecraftDesktop: SCD }, PROVIDERS, { keys: {}, models: {} }, () => null, x => String(x), () => {}, () => {}, () => {}, () => {}, false, () => {}, async () => {},
      () => 0, () => 0, () => "", () => 0, [], () => 0, () => false, new Set(), () => null);
    const before = M.cloudPanelHtml();
    await M.cloudDeleteAll();
    const after = M.cloudPanelHtml();
    ok("cloud off: Delete them shows each result in the panel", after !== before
       && /class="status err" id="cloud-panel-status">The Groq key could not be deleted: your system keychain is locked, or its prompt was dismissed\. Unlock it and try again\. The Google AI Studio key was deleted from this computer\./.test(after), after);
    ok("cloud off: the key line still offers Delete them for the key that stayed", /Your Groq key is still in your system keychain/.test(after) && !/Your Google AI Studio key/.test(after));
  }
  /* ---- v2 review: the sheet's header and fine print follow the cloud switch ---- */
  {
    const fnSrc = name => { const i = html.indexOf(name); let d = 0, j = html.indexOf("{", i);
      for (; j < html.length; j++){ if (html[j] === "{") d++; else if (html[j] === "}" && --d === 0) break; } return html.slice(i, j + 1); };
    const node = () => ({ textContent: "", innerHTML: "" });
    const run = on => {
      const head = { h2: node(), p: node(), querySelector(q){ return q === "h2" ? this.h2 : this.p; } };
      const ps = [node(), node()], fine = node();
      const doc = { querySelector: q => q === "#sheet .card-head" ? head : (q === "#sheet .card-body > p.fine:last-child" ? fine : null), querySelectorAll: () => ps };
      new Function("globalThis", "document", "$", fnSrc("function desktopCopy(){") + "\ndesktopCopy();")({ __stagecraftDesktop: { cloud: { on } } }, doc, () => node());
      return head.p.textContent + " | " + ps[0].innerHTML + " | " + fine.textContent;
    };
    const off = run(false), on = run(true);
    ok("copy: cloud off is v1's wording", /runs every stage on a model installed here/.test(off) && /sends nothing anywhere/.test(off));
    ok("copy: cloud on, neither the header nor the fine print says everything stays here",
       !/runs every stage|sends nothing anywhere/.test(on) && /can send a stage to a free service you turned on below/.test(on)
       && /only to the free services you turned on below/.test(on) && /unless you chose Don't ask again/.test(on), on);
  }
  /* ---- v2 review (a11y): card messages are announced; focus goes to the card's next step ---- */
  {
    const said = [], focused = [];
    const mk = id => ({ id, focus(){ focused.push(id); }, contains: () => false, hidden: false });
    const els = { "cloud-key-groq": mk("cloud-key-groq"), sheet: Object.assign(mk("sheet"), { contains: () => true }), provs: mk("provs") };
    const body = {};
    const doc = { body, activeElement: body, querySelector: () => null };
    const M = new Function("globalThis", "document", "PROVIDERS", "S", "$", "esc", "save", "renderProvs", "renderGauges", "renderAll", "busy", "sheetSay", "recheck",
      "left", "cap", "resetsIn", "rank", "TIERS", "used", "modelSpent", "DEAD", "unfitReason",
      CLOUD + "\nreturn { cloudSay, cloudRefocus, cloudFocusWasIn };")(
      { __stagecraftDesktop: {} }, doc, { openrouter: { name: "OpenRouter" }, groq: { name: "Groq" }, gemini: { name: "Google AI Studio" } }, {}, id => els[id] || null, x => String(x), () => {}, () => {}, () => {}, () => {}, false,
      (t, u) => said.push([t, !!u]), async () => {}, () => 0, () => 0, () => "", () => 0, [], () => 0, () => false, new Set(), () => null);
    M.cloudSay("groq", "Checking with Groq…"); M.cloudSay("groq", "Groq did not accept that key. Nothing was saved.", "err");
    ok("a11y: card messages go to the persistent regions, errors to the assertive one",
       JSON.stringify(said) === JSON.stringify([["Checking with Groq…", false], ["Groq did not accept that key. Nothing was saved.", true]]), said);
    M.cloudRefocus("groq", true);
    ok("a11y: after Turn on, focus lands on the key field instead of <body>", focused[0] === "cloud-key-groq", focused);
    M.cloudRefocus("groq", false);
    ok("a11y: a pointer action (focus was not in the sheet) moves nothing", focused.length === 1);
  }
  /* ---- R-86 (v2 review): opting in from the ceiling notice opens the walkthrough; every outcome is visible ---- */
  {
    const order = [];
    const els = { sheet: { hidden: true } };
    const el = id => els[id] || (els[id] = { id, value: "", innerHTML: "", hidden: false, textContent: "" });
    const SCD = { cloud: { on: false, providers: {} }, fresh: new Set(), cloudEnable: async () => ({ on: true, providers: {} }),
                  cloudDisable: async () => { throw new Error("boom"); } };
    const win = { openSheet: () => { order.push("open"); els.sheet.hidden = false; } };
    const PROVIDERS = { openrouter: { name: "OpenRouter" }, groq: { name: "Groq" }, gemini: { name: "Google AI Studio" } };
    const M = new Function("globalThis", "window", "PROVIDERS", "S", "$", "esc", "save", "renderProvs", "renderGauges", "renderAll", "busy", "sheetSay", "recheck",
      "left", "cap", "resetsIn", "rank", "TIERS", "used", "modelSpent", "DEAD", "unfitReason",
      CLOUD + "\nreturn { cloudToggle, cloudPanelHtml, CLOUD_UI };")(
      { __stagecraftDesktop: SCD }, win, PROVIDERS, { keys: {}, models: {} }, el, x => String(x), () => {}, () => order.push("provs"), () => {},
      () => order.push("all"), false, (t, u) => order.push("say:" + (u ? "!" : "") + t), async () => {},
      () => 200, () => 200, () => "3h", t => ["low", "medium", "high"].indexOf(t), ["low", "medium", "high"], () => 0, () => false, new Set(), () => null);
    await M.cloudToggle(true);
    ok("R-86: Yes from a closed sheet opens it at OpenRouter, then announces", M.CLOUD_UI.setup === "openrouter" && order[0] === "open" && order[1] === "say:Free cloud models are on. Turn on a service below.", order);
    SCD.cloud = { on: true, providers: {} };
    ok("R-86: the outcome is visible in the cloud panel", /id="cloud-panel-status">Free cloud models are on/.test(M.cloudPanelHtml()));
    order.length = 0;
    await M.cloudToggle(false);
    ok("R-86: a failure is shown in the panel, announced urgently, and leaves the notices alone",
       /class="status err" id="cloud-panel-status">Stagecraft could not change cloud use: boom/.test(M.cloudPanelHtml()) && order.includes("say:!Stagecraft could not change cloud use: boom") && !order.includes("all"), order);
    SCD.cloudEnable = async () => ({ on: false, providers: {} }); els.sheet.hidden = true; order.length = 0;
    await M.cloudToggle(true);
    ok("R-86: a No keeps the ceiling notice (no re-render) and opens nothing", !order.includes("open") && !order.includes("all"), order);
  }
  console.log(fail ? `desktop-cloud.test.js: ${pass} passed, ${fail} FAILED` : `desktop-cloud.test.js: ${pass} assertions passed`);
  process.exit(fail ? 1 : 0);
})();
