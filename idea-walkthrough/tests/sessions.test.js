#!/usr/bin/env node
// Fake keys are built from two pieces so secret scanners do not flag them.
// Sessions (2026-11-17): every launch starts a new walkthrough, the one that was open is kept in
// S.sessions, and the list can open, delete and start walkthroughs. Source is lifted from
// index.html so it cannot drift.
//   Run:  node tests/sessions.test.js
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
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got).slice(0, 400) : "")));

const REC = cut("/* ---------- sessions: the record", "/* ---------- power tiers");
const LIST = cut("/* ---------- sessions: the list", "/* ---------- provider setup");
const STAGES = new Function(cut("const STAGES = [", "const stage = () =>") + "\nreturn STAGES;")();
const PROVIDERS = { local: { name: "On this computer", keyless: true }, groq: { name: "Groq" }, openrouter: { name: "OpenRouter" } };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const APP_WIDE = ["keys", "models", "ledger", "mledger", "limits", "theme", "debug", "cloudAck", "ackAfter", "autoLower", "capObs", "resetObs",
                  "prefill", "cloudRoute", "allowanceCheckedAt", "localInstalled", "exportN", "selftestMarker", "lastRun", "sessions", "sessionMeta"];

function mkStorage(throws){
  const m = new Map();
  if (throws) return { getItem(){ throw new Error("denied"); }, setItem(){ throw new Error("denied"); }, removeItem(){} };
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}
/* One page boot: the record block runs against `state` (as store.read() would hand it over), then
   the list block. Returns the page's functions and handles on what it touched. */
function boot(state, opt){
  opt = opt || {};
  const env = { written: null, writes: 0, notices: [], said: "", focused: null, rendered: 0, busy: !!opt.busy };
  const store = { write(s){ env.writes++; if (opt.writeFails) return false; env.written = JSON.stringify(s); return true; } };
  const dom = { "sessions-body": { innerHTML: "" } };
  const el = id => ({ id, value: "", focus(){ env.focused = id; } });
  const $ = id => dom[id] || ((id === "input" || id === "btn-session-new") ? el(id)
                 : (dom["sessions-body"].innerHTML.includes('id="' + id + '"') ? el(id) : null));
  const G = opt.desk ? { __stagecraftDesktop: opt.desk } : {};
  const M = new Function("globalThis", "sessionStorage", "store", "PERSISTENT", "STAGES", "PROVIDERS", "esc", "$", "notice", "srSay", "keepFocus", "env",
    'const LS = "stagecraft.v1";\nlet S = env.S, busy = env.busy;\n'
    + "const save = () => { noteWalkChange(); return store.write(S); };\n"
    + "const renderAll = () => { env.rendered++; renderSessions(); };\n"
    + fnSrc("function titleOf(") + fnSrc("function sentStages(") + fnSrc("function sentLine(") + "\n"
    + REC + "\n" + LIST
    + "\nreturn { S: () => S, setS: v => { S = v; }, setBusy: v => { busy = v; }, save, launchSessions, swapWalk, hasWalkContent, cleanWalk, sessionOf, WALK_FIELDS,"
    + " SESSION_BUDGET, SESSIONS_UI, stateWeight, renderSessions, sessionNew, sessionOpen, sessionAskDelete, sessionKeep, sessionDelete, noteWalkChange };")(
    G, opt.tab || mkStorage(), store, opt.persistent !== false, STAGES, PROVIDERS, esc, $,
    (h, kind) => env.notices.push({ h, kind }), t => { env.said = t; }, (c, r) => r(), Object.assign(env, { S: state }));
  M.env = env; M.dom = dom;
  return M;
}
const full = () => ({
  keys: { openrouter: ("sk-" + "or-v1-test-only-browserkey"), local: "local" }, models: { local: [{ id: "qwen3:14b", tier: "medium" }] },
  ledger: { groq: { used: 3 } }, mledger: { x: 1 }, limits: { groq: 200 }, theme: "dark", debug: [{ stage: "capture", model: "m" }],
  cloudAck: { "critique|groq": 1 }, autoLower: true, exportN: 4, selftestMarker: "mk",
  idea: "A weekly paper planner for a small allotment garden", stage: 2, drafts: { structure: "half-typed" },
  outputs: { capture: "C", "capture:run": { where: "local", provider: "local", tier: "medium", model: "qwen3:14b" }, diverge: "D",
             critique: "Cr", "critique:run": { where: "cloud", provider: "groq", tier: "high", model: "llama", host: "api.groq.com" } },
  exportedStages: 2, exportedAt: 1700000000000, sentTo: { groq: ["critique"] }, sentFrom: {}, localOnly: true,
});

/* ---- launch: a non-empty walkthrough is archived and an empty one starts ---- */
const tab = mkStorage();
let saved;
{
  const P = boot(full(), { tab });
  const r = P.launchSessions(), S = P.S();
  ok("launch: archives the walkthrough that has content", r && r.ok && S.sessions.length === 1, r);
  ok("launch: the new current walkthrough is empty", S.idea === "" && JSON.stringify(S.outputs) === "{}" && S.stage === 0 && JSON.stringify(S.drafts) === "{}"
     && S.exportedStages === 0 && S.exportedAt === null && JSON.stringify(S.sentTo) === "{}" && S.localOnly === false);
  const x = S.sessions[0];
  ok("launch: the session holds the run, its provenance and keep-local choice",
     x.idea === full().idea && x.outputs.critique === "Cr" && x.outputs["critique:run"].host === "api.groq.com"
     && x.drafts.structure === "half-typed" && x.stage === 2 && x.sentTo.groq[0] === "critique" && x.localOnly === true && x.exportedStages === 2);
  ok("launch: the session has id, dates and the titleOf title", /^[a-z0-9]{4,40}$/.test(x.id) && x.createdAt > 0 && x.updatedAt >= x.createdAt
     && x.title === "A weekly paper planner for a small allotment garden");
  ok("launch: app-wide fields stay where they were", S.keys.openrouter === ("sk-" + "or-v1-test-only-browserkey") && S.ledger.groq.used === 3 && S.exportN === 4 && S.debug.length === 1 && S.cloudAck["critique|groq"] === 1);
  ok("launch: the archive is written", P.env.writes === 1 && JSON.parse(P.env.written).sessions.length === 1);
  ok("launch: the panel says where the old walkthrough went", /in History/.test(P.SESSIONS_UI.note));
  saved = JSON.parse(P.env.written);
}
/* ---- a reload of the same tab is not a launch ---- */
{
  saved.idea = "typed after the launch"; saved.outputs = { capture: "new C" };
  const P = boot(saved, { tab });
  ok("reload: nothing is archived", P.launchSessions() === null && P.S().sessions.length === 1 && P.S().idea === "typed after the launch" && P.env.writes === 0);
  const P2 = boot(JSON.parse(JSON.stringify(saved)), { tab: mkStorage() });
  ok("a new tab (fresh sessionStorage) is a launch", P2.launchSessions().ok && P2.S().sessions.length === 2 && P2.S().idea === "");
  const P3 = boot(full(), { tab: mkStorage(true) });
  ok("sessionStorage unusable: treated as a reload (the old behaviour), nothing archived", P3.launchSessions() === null && P3.S().idea !== "");
}
/* ---- desktop: gen and the D-4 replacement window ---- */
{
  const fresh = () => mkStorage();
  ok("desktop: the process's first window (gen 1) is a launch", boot(full(), { tab: fresh(), desk: { gen: 1 } }).launchSessions().ok === true);
  ok("desktop: the D-4 replacement window (gen 2, empty sessionStorage) is not", boot(full(), { tab: fresh(), desk: { gen: 2 } }).launchSessions() === null);
  const t = fresh(); t.setItem("stagecraft.v1.open", "1");
  ok("desktop: the reloaded old window (gen 1, marker kept) is not", boot(full(), { tab: t, desk: { gen: 1 } }).launchSessions() === null);
  ok("desktop: never under the self-test harness (A-59f, A-40x read the previous launch's run)",
     boot(full(), { tab: fresh(), desk: { gen: 1, selftest: { action: "fork" } } }).launchSessions() === null);
  const t2 = fresh(); boot(full(), { tab: t2, desk: { gen: 2 } }).launchSessions();
  ok("desktop: a replacement window still sets the marker, so its own reload is not a launch either", t2.getItem("stagecraft.v1.open") === "1");
}
/* ---- an empty walkthrough is never archived ---- */
{
  const empty = { keys: {}, models: {}, ledger: {}, mledger: {}, limits: {}, stage: 3, idea: "  ", outputs: { "capture:run": { model: "m" } }, drafts: { capture: "   " }, theme: null };
  const P = boot(empty, { tab: mkStorage() });
  ok("empty: a launch archives nothing and writes nothing", P.launchSessions() === null && P.S().sessions.length === 0 && P.env.writes === 0);
  P.sessionNew();
  ok("empty: New walkthrough archives nothing", P.S().sessions.length === 0 && /Run <b>Capture<\/b> to begin/.test(P.env.notices.pop().h));
  const D = boot({ keys: {}, idea: "", outputs: {}, drafts: { capture: "only typed, never run" } }, { tab: mkStorage() });
  ok("a typed, unrun idea counts as content (an archive must not drop what was typed)", D.launchSessions().ok && D.S().sessions[0].title === "only typed, never run");
}
/* ---- New, Open, Delete ---- */
{
  const P = boot(full(), { tab: mkStorage() });
  P.sessionNew();
  const first = P.S().sessions[0];
  ok("new: archives the current walkthrough and starts fresh", P.S().sessions.length === 1 && P.S().idea === "" && P.env.focused === "input");
  P.S().idea = "Second idea"; P.S().outputs = { capture: "S2" }; P.save();
  const secondMeta = Object.assign({}, P.S().sessionMeta);
  ok("open: the chosen session is listed with Open and Delete", /id="sess-open-/.test(P.dom["sessions-body"].innerHTML) && /data-action="session-del"/.test(P.dom["sessions-body"].innerHTML));
  ok("open: done", P.sessionOpen(first.id) === true);
  const S = P.S();
  ok("open: the chosen walkthrough is current, with its own fields", S.idea === full().idea && S.stage === 2 && S.outputs.critique === "Cr" && S.localOnly === true
     && S.sentTo.groq[0] === "critique" && S.drafts.structure === "half-typed" && S.exportedStages === 2);
  ok("open: it keeps its id and created date, and leaves the list", S.sessionMeta.id === first.id && S.sessionMeta.createdAt === first.createdAt && !S.sessions.some(x => x.id === first.id));
  ok("open: the walkthrough that was open is archived first", S.sessions.length === 1 && S.sessions[0].idea === "Second idea" && S.sessions[0].id === secondMeta.id);
  ok("open: says what happened", /Opened “A weekly paper planner/.test(P.env.notices.pop().h));
  const P2 = boot({ keys: {}, idea: "", outputs: {}, sessions: [first] }, { tab: mkStorage() });
  P2.sessionOpen(first.id);
  ok("open from an empty walkthrough archives nothing else", P2.S().sessions.length === 0 && P2.S().idea === full().idea);

  const victim = S.sessions[0].id;
  ok("delete: one click only asks", P.sessionDelete(victim) === false && S.sessions.length === 1);
  P.sessionAskDelete(victim);
  ok("delete: the ask is in the row, focus on Keep it", /Delete this session\?/.test(P.dom["sessions-body"].innerHTML) && P.env.focused === "sess-no-" + victim && /cannot be undone/.test(P.env.said));
  P.sessionKeep(victim);
  ok("delete: Keep it cancels", P.S().sessions.length === 1 && P.SESSIONS_UI.confirm === null && P.env.focused === "sess-del-" + victim);
  P.sessionAskDelete(victim);
  const w = P.env.writes;
  ok("delete: Delete for good removes it and saves", P.sessionDelete(victim) === true && P.S().sessions.length === 0 && P.env.writes === w + 1 && /^Deleted /.test(P.env.said));
  ok("delete: focus lands somewhere real", P.env.focused === "btn-session-new");
  ok("delete: the current walkthrough is untouched", P.S().idea === full().idea);
  ok("no window.confirm / alert / prompt in the sessions code", !/\b(confirm|alert|prompt)\s*\(/.test(REC + LIST));

  P.setBusy(true);
  const before = JSON.stringify(P.S());
  ok("busy: switching while a stage runs is refused, nothing changes", P.sessionNew() === false && JSON.stringify(P.S()) === before && P.env.notices.pop().kind === "blocked");
}
/* ---- the whitelist: nothing app-wide in a session ---- */
{
  const P = boot(Object.assign(full(), { lastRun: null, sessionMeta: { id: "sabcd1234" } }), { tab: mkStorage() });
  P.launchSessions();
  const x = P.S().sessions[0];
  ok("whitelist: a session has exactly id, dates, title and WALK_FIELDS",
     JSON.stringify(Object.keys(x).sort()) === JSON.stringify(["createdAt", "id", "title", "updatedAt"].concat(P.WALK_FIELDS).sort()), Object.keys(x));
  ok("whitelist: no app-wide field", APP_WIDE.every(k => !(k in x)));
  ok("whitelist: no key text anywhere in the sessions", !/sk-or-v1|test-only/.test(JSON.stringify(P.S().sessions)));
  ok("whitelist: WALK_FIELDS is the fork/unfork list", JSON.stringify(P.WALK_FIELDS) === JSON.stringify(["idea", "outputs", "stage", "drafts", "exportedStages", "exportedAt", "sentTo", "sentFrom", "localOnly", "importedStages"]));   // importedStages: 2026-11-18, project import
  P.S().outputs.capture = "changed later";
  P.sessionNew();
  ok("whitelist: a session is a copy, not a reference", P.S().sessions[1].outputs.capture === "C");
}
/* ---- R-95: a key-shaped string planted inside S.sessions is never written ---- */
{
  const planted = { keys: { local: "local" }, idea: "", outputs: {},
    sessions: [{ id: "s1planted", createdAt: 5, updatedAt: 6, idea: "Planted", outputs: { capture: "x" },
                 keys: { groq: ("gsk_" + "test-only-planted-nested") }, apiKey: ("sk-" + "or-v1-test-only-planted"), ledger: { groq: { used: 999 } } },
               "not a session", null, { id: "<img src=x onerror=alert(1)>", idea: "<script>x</script>" }],
    sessionMeta: { id: "sabcd1234", keys: { groq: ("gsk_" + "test-only-meta") } } };
  const P = boot(planted, { tab: mkStorage() });
  P.save();
  ok("R-95: nested keys, unknown fields and app-wide fields in a stored session are never written back",
     !/test-only|apiKey|"ledger"/.test(P.env.written) && JSON.parse(P.env.written).sessions[0].title === "Planted", P.env.written);
  ok("R-95: sessionMeta is rebuilt too", !/gsk_/.test(JSON.stringify(P.S().sessionMeta)));
  ok("stored junk is dropped; a session with an unsafe id gets a new one", P.S().sessions.length === 2 && /^[a-z0-9]{4,40}$/.test(P.S().sessions[1].id));
  P.renderSessions();
  const h = P.dom["sessions-body"].innerHTML;
  ok("rendering escapes every title (esc)", !/<script>/.test(h) && /&lt;script&gt;x&lt;\/script&gt;/.test(h) && !/onerror=/.test(h.replace(/&lt;img[^]*?&gt;/g, "")));
  const rs = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "src-tauri", "src", "state.rs"), "utf8");
  ok("R-95 (desktop): Rust's scrub walks sessions as well (tested in state.rs)", /v\.get_mut\("sessions"\)/.test(rs) && /fn scrub_reaches_keys_planted_inside_sessions/.test(rs));
}
/* ---- Forget everything wipes the sessions ---- */
(async () => {
  const els = { input: { value: "x" }, out: { textContent: "x" }, notices: { innerHTML: "" } };
  const calls = { clear: 0 };
  const UI = { confirm: "s1", note: "n", refused: "r", bytes: 9 };
  const F = new Function("globalThis", "$", "store", "DEAD", "save", "renderProvs", "renderAll", "SESSIONS_UI", "env",
    "let RUN = null, PULL = null, FORGET_GEN = 0, S = env.S;\n" + fnSrc("async function forgetEverything(") + "\nreturn { forgetEverything, S: () => S };")(
    { __stagecraftDesktop: { ask: async () => true } }, id => els[id], { clear: () => calls.clear++ }, new Set(), () => {}, () => {}, () => {}, UI,
    { S: Object.assign(full(), { sessions: [{ id: "s1", idea: "kept?" }], sessionMeta: { id: "sx" } }) });
  await F.forgetEverything();
  ok("forget: sessions and the current session's meta are gone", !("sessions" in F.S()) && !("sessionMeta" in F.S()) && calls.clear === 1);
  ok("forget: the list's own state is reset", UI.confirm === null && UI.note === "" && UI.refused === "" && UI.bytes === 0);

  /* ---- the size guard ---- */
  {
    const big = { id: "sbig0001", createdAt: 1e12, updatedAt: 1e12, idea: "Big", outputs: { capture: "x".repeat(3999500) } };
    const P = boot(Object.assign(full(), { sessions: [big] }), { tab: mkStorage() });
    const before = JSON.stringify(P.S());
    const r = P.launchSessions();
    ok("size: a launch over the browser budget is refused whole", r && r.ok === false && JSON.stringify(P.S()) === before && P.env.writes === 0, r);
    ok("size: ...and the panel says why", /kept your last walkthrough open/.test(P.SESSIONS_UI.refused));
    P.SESSIONS_UI.bytes = P.stateWeight(P.S()); P.renderSessions();
    ok("size: the panel shows the refusal", /kept your last walkthrough open/.test(P.dom["sessions-body"].innerHTML));
    ok("size: New walkthrough is refused with a notice, nothing dropped", P.sessionNew() === false && JSON.stringify(P.S()) === before
       && P.env.notices.slice(-1)[0].kind === "bad" && /Nothing was changed\.<\/b> Keeping another session would make Stagecraft's saved work 4\.\d MB, over the 4\.0 MB/.test(P.env.notices.slice(-1)[0].h));
    ok("size: Delete still works, which is the way out", (P.sessionAskDelete("sbig0001"), P.sessionDelete("sbig0001")) && P.S().sessions.length === 0);
    ok("size: after deleting, New walkthrough fits", P.sessionNew() === true && P.S().sessions.length === 1);

    const W = boot(Object.assign(full(), { sessions: [Object.assign({}, big, { outputs: { capture: "x".repeat(3300000) } })] }), { tab: mkStorage() });
    W.SESSIONS_UI.bytes = W.stateWeight(W.S()); W.renderSessions();
    ok("size: from 80% the panel warns, in plain numbers", /Saved work uses 3\.3 MB of the 4\.0 MB Stagecraft keeps room for/.test(W.dom["sessions-body"].innerHTML));

    const multi = { id: "smb00001", createdAt: 1e12, updatedAt: 1e12, idea: "é", outputs: { capture: "é".repeat(7600000) } };
    const D = boot(Object.assign(full(), { sessions: [multi] }), { tab: mkStorage(), desk: { gen: 1 } });
    const rd = D.launchSessions();
    ok("size: the desktop measures UTF-8 bytes against 15 MB (Rust's cap is 20 MB of bytes)", rd && rd.ok === false && rd.budget === 15000000 && rd.weight > 15000000, rd && { w: rd.weight, b: rd.budget });
    const Db = boot(Object.assign(full(), { sessions: [multi] }), { tab: mkStorage() });
    ok("size: the browser counts characters, so the same 7.6M characters are over its 4M budget too", Db.launchSessions().ok === false);

    const Q = boot(full(), { tab: mkStorage(), writeFails: true });
    const qb = JSON.stringify(Q.S());
    const rq = Q.launchSessions();
    ok("size: a browser write that does not land (quota) is undone", rq.ok === false && rq.unsaved === true && JSON.stringify(Q.S()) === qb && /would not save/.test(Q.SESSIONS_UI.refused));
    const NP = boot(full(), { tab: mkStorage(), writeFails: true, persistent: false });
    ok("size: with storage blocked from the start (nothing persists anyway) the switch still happens in memory", NP.launchSessions().ok === true);
  }

  /* ---- last-updated ---- */
  {
    const P = boot({ keys: {}, idea: "x", outputs: {}, stage: 0 }, { tab: mkStorage() });
    P.save(); const t1 = P.S().sessionMeta.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    P.S().stage = 3; P.save();
    ok("updatedAt: moving between stages is not an edit", P.S().sessionMeta.updatedAt === t1);
    P.S().outputs.capture = "an answer"; P.save();
    ok("updatedAt: an answer is", P.S().sessionMeta.updatedAt > t1 && P.S().sessionMeta.sig.length <= 8);
  }

  /* ---- Fork and Undo fork are unchanged, and Fork's previous run becomes a session ---- */
  {
    const P = boot(Object.assign(full(), { sessions: [{ id: "sold0001", idea: "Old", outputs: { capture: "o" }, createdAt: 1e12, updatedAt: 1e12 }] }), { tab: mkStorage() });
    const S0 = P.S();
    const env = { notices: "" }, unfork = { onclick: null };
    const $ = id => id === "btn-unfork" ? (env.notices.includes("btn-unfork") ? unfork : null) : (id === "input" ? { value: "" } : null);
    const mkFork = () => new Function("globalThis", "$", "notice", "STAGES", "esc", "save", "renderAll", "renderSaveReminder", "buildMd", "exportName", "env", "getS", "setS",
      "let S = getS();\n" + fnSrc("function sentStages(") + fnSrc("function exportMd(") + fnSrc("async function forkIdea(") + "\nreturn { forkIdea };")(
      { __stagecraftDesktop: { saveExport: async () => ({ saved: true, path: "/tmp/a.md" }) } }, $, h => { env.notices = h; }, STAGES, esc, P.save, () => {}, () => {},
      () => "# md", () => "a.md", env, P.S, P.setS);
    const sessionsBefore = JSON.stringify(S0.sessions);
    await mkFork().forkIdea("A forked idea");
    ok("fork: works as before (lastRun holds the old run, new idea current)", S0.idea === "A forked idea" && S0.lastRun && S0.lastRun.idea === full().idea && S0.sentFrom.groq[0] === "critique");
    ok("fork: the sessions list is untouched", JSON.stringify(S0.sessions) === sessionsBefore);
    unfork.onclick();
    ok("unfork: brings the previous run back, with its own localOnly and sentTo", S0.idea === full().idea && S0.localOnly === true && S0.sentTo.groq[0] === "critique" && S0.lastRun === null);
    ok("unfork: the sessions list is untouched", JSON.stringify(S0.sessions) === sessionsBefore);
    await mkFork().forkIdea("Forked again");
    P.sessionNew();
    const titles = P.S().sessions.map(x => x.title);
    ok("fork + New walkthrough: both the forked idea and the run Fork kept become sessions; nothing is buried",
       titles[0] === "Forked again" && titles[1] === full().idea && titles[2] === "Old" && P.S().lastRun === null, titles);
    ok("fork: forkIdea and its unfork handler do not mention sessions", !/session/i.test(fnSrc("async function forkIdea(")));
  }

  /* ---- wiring and conventions ---- */
  ok("renderAll draws the list", /renderAll = \(\) => \{[^}]*renderSessions\(\)/.test(html));
  ok("the launch rule runs at boot, before the first render", html.indexOf("\nlaunchSessions();") > 0 && html.indexOf("\nlaunchSessions();") < html.indexOf("\nrenderAll();\n/* Desktop detection"));
  ok("every action goes through the one delegated listener (R-41)", ["session-new", "session-open", "session-del", "session-del-yes", "session-del-no"]
     .every(a => html.includes('else if (act === "' + a + '")')) && !/ on[a-z]+="/.test(LIST + cut('<aside class="sessions"', "</aside>")));
  ok("the history is a labelled region on the left (2026-11-18: owner asked for it there)", /<aside class="sessions" id="sessions" aria-labelledby="sessions-title">/.test(html) && /id="sessions-title">History</.test(html)
     && html.indexOf('<aside class="sessions"') < html.indexOf('<div class="board">'));
  ok("the History button controls it and says whether it is open", /<button class="iconbtn" id="btn-history" aria-controls="sessions" aria-expanded="true">History<\/button>/.test(html));
  ok("the list re-renders through keepFocus", /keepFocus\(el, \(\) => \{/.test(fnSrc("function renderSessions(")));
  ok("save() stamps the walkthrough before writing", /const save = \(\) => \{ noteWalkChange\(\); return store\.write\(S\); \};/.test(html));

  console.log(fail ? `sessions.test.js: ${pass} passed, ${fail} FAILED` : `sessions.test.js: ${pass} assertions passed`);
  process.exit(fail ? 1 : 0);
})();
