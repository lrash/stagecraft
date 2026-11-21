#!/usr/bin/env node
// DESIGN-desktop v2-6: the send disclosure (R-98) and provenance (R-99, R-102), unit halves.
//   Run:  node tests/desktop-provenance.test.js
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

const STAGES = new Function(cut("const STAGES = [", "const stage = () =>") + "\nreturn STAGES;")();
const PROVIDERS = { local: { name: "On this computer", keyless: true }, groq: { name: "Groq" }, openrouter: { name: "OpenRouter" } };
const DISC = cut("/* ---------- R-98: what a cloud send carries", "/* S.autoLower was a one-way latch");

/* ---- R-98: acknowledgements and the summary ---- */
{
  const S = { stage: 5, outputs: { capture: "c", diverge: "d", structure: "s", deepen: "dp", critique: "cr" }, cloudAck: { "critique|groq": 1000 }, ackAfter: 0 };
  const M = new Function("S", "STAGES", "PROVIDERS", "floorCoverage", "SORT_ROOM_CAP", DISC + "\nreturn { ackCounts, discloseSummary };")(S, STAGES, PROVIDERS, () => [], 1000);
  ok("R-98: a tick counts for that (stage, provider) only", M.ackCounts("critique", "groq") && !M.ackCounts("critique", "openrouter") && !M.ackCounts("deepen", "groq"));
  S.ackAfter = 2000;
  ok("R-102: an ack older than ackAfter does not count", !M.ackCounts("critique", "groq"));
  const rec = STAGES.find(s => s.id === "reconcile");
  const sum = M.discloseSummary(rec, "one two three four");
  ok("R-98: the summary names what is kept and what is withheld",
     sum === "about 4 words, made up of your Capture contract, the Critique objections, and Reconcile's instructions (Diverge, Structure, Deepen withheld).", sum);
  S.stage = 0;
  ok("R-98: Capture sends the idea as typed", /made up of your idea as typed, and Capture's instructions\.$/.test(M.discloseSummary(STAGES[0], "x")));
}
/* ---- R-98: the panel is awaited in the attempt loop, before chat(), and is not an attempt ---- */
{
  const rs = fnSrc("async function runStage(");
  const loop = rs.slice(rs.indexOf("while (c && attempts < MAX_ATTEMPTS){"));
  ok("R-98: the panel comes before attempts++ and before chat()",
     loop.indexOf("await discloseSend(") > 0 && loop.indexOf("await discloseSend(") < loop.indexOf("attempts++") && loop.indexOf("attempts++") < loop.indexOf(".chat("));
  ok("R-98: only cloud attempts on the desktop ask", /if \(!PROVIDERS\[c\.provider\]\.keyless && globalThis\.__stagecraftDesktop && !approved\.has\(c\.provider\)\)\{/.test(rs));
  // 2026-11-18: both go through one promptOf(), so a quality-gate revision note is shown too.
  ok("R-98: the panel shows exactly the prompt chat() sends", /discloseSend\(s, c, promptOf\(\)\)/.test(rs)
     && /\.chat\(S\.keys\[c\.provider\], c\.id, promptOf\(\),/.test(rs)
     && /const promptOf = \(\) => s\.prompt\(S\.idea, contextSoFar\(s\), S\.stage === 0 \? "" : extra\) \+ \(rev \? rev\.note : ""\);/.test(rs));
  ok("R-98: dismissing ends the stage with nothing counted", /Nothing was sent\.<\/b> " \+ esc\(s\.name\) \+ " did not run, and nothing was counted or saved/.test(rs));
  ok("R-98: 'keep' sets localOnly and runs locally (forced when below floor)", /if \(ans === "keep"\)\{ S\.localOnly = true; save\(\); \}/.test(rs) && /forced = rank\(lc\.tier\) < rank\(s\.floor\) \? lc : null;/.test(rs));
  const d = fnSrc("async function discloseSend(");
  ok("R-98: 'Show exactly' uses textContent", /t\.textContent = prompt/.test(d) && !/innerHTML\s*=\s*prompt/.test(d));
  ok("R-98: Forget (RUN.abort) answers a waiting panel, so the stage never hangs", /RUN\.signal\.addEventListener\("abort", onAbort\)/.test(d) && /const onAbort = \(\) => done\("dismiss"\);/.test(d));
  ok("R-98: a re-render keeps the waiting panel", /if \(!\(typeof DISCLOSING !== "undefined" && DISCLOSING\)\) \$\("notices"\)\.innerHTML = "";/.test(fnSrc("function renderStage(")));
}
/* ---- R-99: provenance text, receipt, export ---- */
{
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const R = new Function("esc", "PROVIDERS", "S", cut("function fmtMs(ms){", '/* ---------- "save your work"') + "\nreturn { receiptHtml, receiptText, provenanceText };")(esc, PROVIDERS, { autoLower: false });
  const cloud = { tier: "high", model: "llama-3.3-70b-versatile", provider: "groq", left: "199 of 200 left today", where: "cloud", host: "api.groq.com", floor: "high" };
  const local = { tier: "medium", model: "qwen3:14b", provider: "local", left: "no limit", where: "local", host: "this computer", floor: "medium" };
  ok("R-99: a cloud receipt", R.provenanceText(cloud) === "Answered by Groq · llama-3.3-70b-versatile (HIGH) · sent over the internet to api.groq.com");
  ok("R-99: a local receipt", R.provenanceText(local) === "Answered on this computer · qwen3:14b (MEDIUM)");
  ok("R-99: the receipt and its text carry it", /sent over the internet to api\.groq\.com/.test(R.receiptHtml(cloud)) && /^high · Answered by Groq/.test(R.receiptText(cloud)));
  ok("R-99: a record without `where` (browser, or before v2) renders as before", /answered by <b>qwen3:14b<\/b> via <b>On this computer<\/b>/.test(R.receiptHtml({ tier: "low", model: "qwen3:14b", provider: "local" })));
  const rs = fnSrc("async function runStage(");
  ok("R-99: :run gains where and host on the desktop only",
     /\.\.\.\(globalThis\.__stagecraftDesktop \? \{ where: PROVIDERS\[c\.provider\]\.keyless \? "local" : "cloud",/.test(rs));

  const mk = (S, desk) => new Function("globalThis", "S", "STAGES", "PROVIDERS", "titleOf", "demoteHeadings", "floorNote", "receiptText", "groundingCheck", "provenanceText",
    fnSrc("function sentStages(") + fnSrc("function sentLine(") + fnSrc("function buildMd(){") + fnSrc("function exportProvenance(){") + "\nreturn buildMd;")(
    desk ? { __stagecraftDesktop: {} } : {}, S, STAGES, PROVIDERS, x => x, x => x, () => "", R.receiptText, () => ({ ready: false }), R.provenanceText);
  const S = { idea: "An idea", outputs: { capture: "C", "capture:run": local, diverge: "D", "diverge:run": Object.assign({}, local, { model: "qwen3:8b", tier: "low" }),
              deepen: "Dp", "deepen:run": cloud, critique: "Cr", "critique:run": cloud }, debug: [] };
  const md = mk(S, true)();
  ok("R-99: the export header lists the providers from :run.where", /\nSent to: Groq \(Deepen, Critique\)\n/.test(md), md.slice(0, 200));
  ok("R-99: each stage carries its provenance line under its heading",
     /## Capture\n\n_Answered on this computer · qwen3:14b \(MEDIUM\)_\n\nC/.test(md) && /## Critique\n\n_Answered by Groq · llama-3\.3-70b-versatile \(HIGH\) · sent over the internet to api\.groq\.com_/.test(md), md);
  const loc = mk({ idea: "x", outputs: { capture: "C", "capture:run": local }, localOnly: false, debug: [] }, true)();
  ok("R-102: an idea with no cloud answer says it never left", /\nThis idea never left this computer\.\n/.test(loc));
  const fromFlag = mk({ idea: "x", outputs: { critique: "Cr", "critique:run": cloud }, localOnly: true, debug: [] }, true)();
  ok("R-99: the header comes from the records, never from S.localOnly", /Sent to: Groq \(Critique\)/.test(fromFlag));
  const plain = JSON.parse(JSON.stringify(S, (k, v) => (k === "where" || k === "host") ? undefined : v));   // browser records carry neither
  ok("R-99: the browser export is unchanged (no header, no lines)", !/Sent to|never left|Answered/.test(mk(plain, false)()));
}
/* ---- R-99 (v2 review): every delivered cloud send is recorded, whatever replaces its answer ---- */
{
  const esc = s => String(s);
  const R = new Function("esc", "PROVIDERS", "S", cut("function fmtMs(ms){", '/* ---------- "save your work"') + "\nreturn { receiptText, provenanceText };")(esc, PROVIDERS, { autoLower: false });
  const mk = S => new Function("globalThis", "S", "STAGES", "PROVIDERS", "titleOf", "demoteHeadings", "floorNote", "receiptText", "groundingCheck", "provenanceText",
    fnSrc("function sentStages(") + fnSrc("function sentLine(") + fnSrc("function buildMd(){") + fnSrc("function exportProvenance(){") + "\nreturn buildMd;")(
    { __stagecraftDesktop: {} }, S, STAGES, PROVIDERS, x => x, x => x, () => "", R.receiptText, () => ({ ready: false }), R.provenanceText);
  const local = { tier: "medium", model: "qwen3:14b", provider: "local", left: "no limit", where: "local", host: "this computer", floor: "high" };
  const noteSent = (S, desk) => new Function("globalThis", "S", "PROVIDERS", fnSrc("function noteSent(") + "\nreturn noteSent;")(desk ? { __stagecraftDesktop: {} } : {}, S, PROVIDERS);
  // Path A: Groq answered Critique, then a local re-run replaced the answer.
  const A = { idea: "x", outputs: { critique: "Cr", "critique:run": local }, debug: [] };
  noteSent(A, true)("groq", "critique");
  const mdA = mk(A)();
  ok("R-99: a cloud answer replaced by a local re-run is still in the header", /\nSent to: Groq \(Critique\)\n/.test(mdA) && !/never left/.test(mdA), mdA.slice(0, 200));
  ok("R-99: the stage line describes the answer shown", /## Critique\n\n_Answered on this computer · qwen3:14b \(MEDIUM\)_/.test(mdA));
  // Path B: a delivered failure (5xx, timeout, cancelled:sent), then nothing or a local answer.
  const B = { idea: "x", outputs: { capture: "C", "capture:run": local }, debug: [] };
  const nB = noteSent(B, true); nB("groq", "critique"); nB("groq", "critique"); nB("openrouter", "deepen"); nB("local", "capture");
  const mdB = mk(B)();
  ok("R-99: a delivered failure is in the header, once per stage, local never", /\nSent to: Groq \(Critique\); OpenRouter \(Deepen\)\n/.test(mdB) && JSON.stringify(B.sentTo) === '{"groq":["critique"],"openrouter":["deepen"]}', [mdB.slice(0, 200), B.sentTo]);
  const brow = {}; noteSent(brow, false)("groq", "critique");
  ok("R-99: the browser records nothing", brow.sentTo === undefined);
  const F = { idea: "y", outputs: {}, sentTo: {}, sentFrom: { groq: ["critique"] }, debug: [] };
  ok("R-99: a fork of a sent idea says so, without claiming its own sends", /\nThis idea was not sent anywhere, but the idea it was forked from was sent to: Groq \(Critique\)\.\n/.test(mk(F)()));
  const rs = fnSrc("async function runStage(");
  ok("R-99: noteSent runs on success and on every delivered failure, before the ledger saves",
     /noteSent\(c\.provider, s\.id\);\n\s*spend\(c\.provider\);/.test(rs) && /if \(e && e\.delivered\)\{\n\s*noteSent\(c\.provider, s\.id\);/.test(rs));
  const fork = fnSrc("async function forkIdea(");
  ok("R-99: lastRun keeps the record, Fork moves it to sentFrom, unfork restores it",
     /sentTo: sentStages\(S\.sentTo\), sentFrom: sentStages\(S\.sentFrom\)/.test(fork) && /S\.sentFrom = from; S\.sentTo = \{\};/.test(fork)
     && /S\.sentTo = sentStages\(S\.lastRun\.sentTo\); S\.sentFrom = sentStages\(S\.lastRun\.sentFrom\);/.test(fork));
}
/* ---- R-98 (v2 review): the destination line tells the truth after "Don't ask again" ---- */
{
  const rsd = fnSrc("function renderStage(");
  ok("R-98: a ticked (stage, provider) says it will be sent without asking, with a way back",
     /const acked = ackCounts\(s\.id, going\.provider\);/.test(rsd) && /without asking first \(you chose Don't ask again\)/.test(rsd)
     && /data-action="cloud-ask-again" data-ack="\$\{esc\(s\.id \+ "\|" \+ going\.provider\)\}"/.test(rsd) && /: "after you see what is sent"\}/.test(rsd));
  const del = cut('else if (act === "cloud-ask-again"){', "});");
  ok("R-98: Ask me again clears only that acknowledgement", /delete S\.cloudAck\[k\]; save\(\);/.test(del) && /hasOwnProperty\.call\(S\.cloudAck, k\)/.test(del));
}
/* ---- R-102: fork, unfork and the toggle ---- */
{
  const fork = fnSrc("async function forkIdea(");
  ok("R-102: lastRun saves localOnly", /S\.lastRun = \{[^}]*localOnly: !!S\.localOnly,?[^}]*\};/.test(fork));   // 2026-11-18: importedStages follows it
  ok("R-102: fork keeps the current flag (it is not reset)", !/S\.localOnly = (false|null)/.test(fork.slice(0, fork.indexOf("btn-unfork"))));
  ok("R-102: unfork restores idea A's flag", /S\.localOnly = !!S\.lastRun\.localOnly;/.test(fork));
  const S = { localOnly: true };
  new Function("S", "save", "busy", "renderAll", fnSrc("function setLocalOnly(") + "\nreturn setLocalOnly;")(S, () => {}, true, () => {})(false);
  ok("R-102: turning it off sets ackAfter", S.localOnly === false && typeof S.ackAfter === "number" && S.ackAfter > 0);
  ok("R-102: new ideas are not local-only by default", !/localOnly: true/.test(cut("let S = Object.assign(", "\n")));
}
console.log(fail ? `desktop-provenance.test.js: ${pass} passed, ${fail} FAILED` : `desktop-provenance.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
