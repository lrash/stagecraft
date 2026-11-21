#!/usr/bin/env node
// 2026-11-18 night: Quick plan. One strong prompt in one call scored 13.58/15 against the full
// pipeline's best runs at 13.83 and a plain one prompt at 11.0 (three ideas, two blind judges each;
// the author's blind grading, not published), and every judge named a one-prompt output the
// most useful. Quick plan is that prompt as a mode: it runs through runStage like a stage but is not
// on the stage ladder (R-8 unchanged). Also: the copy-and-paste route for an AI the user already has.
//   Run:  node tests/quick-plan.test.js
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };
let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

// --- the prompt is the measured one, byte for byte -------------------------------------------------
const BLOCK = cut("const STAGES = [", "/* ---------- rendering");
const S = { stage: 0, outputs: {}, mode: undefined };
const P = new Function("S", "floorNote", "demoteHeadings", BLOCK + "\nreturn { STAGES, QUICK, QUICK_PROMPT, stage, isQuick, atFirst, PLAN_STAGES, autoMode, contextSoFar };")(S, () => "", x => x);
const sha = crypto.createHash("sha256").update(P.QUICK_PROMPT, "utf8").digest("hex");
ok("QUICK_PROMPT is prompts/strong-oneshot-v1.md as graded (sha256 6a0dcbde…3daa)",
   sha === "6a0dcbde0596a827d8a9ba82a6cd91e81c05a59cd4fdcedc3872623dfc813daa", sha);
ok("the idea is appended after 'IDEA:'", P.QUICK.prompt("Build a shed") === P.QUICK_PROMPT + "Build a shed" && /IDEA:\n$/.test(P.QUICK_PROMPT));
ok("it asks for the four parts the judges scored", ["PART 1 — WHAT WAS ASKED", "PART 2 — BEFORE YOU START", "PART 3 — THE PLAN", "PART 4 — CHECK BEFORE RELYING"].every(h => P.QUICK_PROMPT.includes(h)));
ok("high floor (it was measured on the free high model)", P.QUICK.floor === "high");

// --- not on the ladder -------------------------------------------------------------------------------
ok("STAGES is still the eight stages (R-8)", P.STAGES.length === 8 && !P.STAGES.some(s => s.id === "quick"), P.STAGES.map(s => s.id));
ok("PLAN_STAGES adds Quick plan for export and provenance only", P.PLAN_STAGES().map(s => s.id).join() === P.STAGES.map(s => s.id).concat(["quick"]).join());

// --- the mode -----------------------------------------------------------------------------------------
S.mode = "walk"; S.stage = 3;
ok("walk mode: stage() is the ladder stage", P.stage().id === P.STAGES[3].id && !P.isQuick() && !P.atFirst());
S.mode = "quick";
ok("quick mode: stage() is Quick plan, and it is a first step (the idea is typed here)", P.stage().id === "quick" && P.atFirst());
S.outputs = { capture: "CAPTURE-BODY", diverge: "DIVERGE-BODY" };
ok("quick mode sends nothing from the ladder as context", P.contextSoFar(P.QUICK) === "(nothing yet)", P.contextSoFar(P.QUICK));
S.mode = undefined; S.stage = 2;
ok("no mode set (the grading runner, old state): the ladder behaves as before", P.contextSoFar(P.STAGES[2]).includes("CAPTURE-BODY"));

S.mode = "walk"; S.outputs = { quick: "PLAN" };
P.autoMode(); ok("a walkthrough holding only a Quick plan opens in Quick plan", S.mode === "quick");
S.mode = "quick"; S.outputs = { capture: "C", diverge: "D" };
P.autoMode(); ok("a walked run opens in the full walkthrough", S.mode === "walk");
S.mode = "quick"; S.outputs = { capture: "C", quick: "Q" };
P.autoMode(); ok("a run with both keeps the current view", S.mode === "quick");

// --- storage and provenance -------------------------------------------------------------------------
const SAN = cut("const OUT_ID = ", "/* \"Has content\"");
const clean = new Function(SAN + "\nreturn { cleanOutputs, cleanRun };")();
const kept = clean.cleanOutputs({ quick: "PLAN", "quick:run": { where: "pasted", host: "another AI", tier: "x\n## Capture" } });
ok("a Quick plan answer and its pasted record survive the typed rebuild", kept.quick === "PLAN" && kept["quick:run"].where === "pasted" && kept["quick:run"].host === "another AI" && !kept["quick:run"].tier, kept);
ok("any other 'where' is still dropped", !("where" in clean.cleanRun({ where: "somewhere" })));
const PROV = cut("function provenanceText(r){", "function receiptHtml(r){");
const provenanceText = new Function("PROVIDERS", PROV + "\nreturn provenanceText;")({});
ok("a pasted answer says Stagecraft did not send it", /Pasted in by you from another AI · Stagecraft did not send it/.test(provenanceText({ where: "pasted", host: "another AI" })));

// --- page wiring (source checks; the DOM paths run in the app) ---------------------------------------
ok("mode switch: two buttons, actions, aria-pressed", /id="btn-mode-quick" data-action="mode-quick" aria-pressed/.test(html) && /id="btn-mode-walk" data-action="mode-walk" aria-pressed/.test(html));
ok("copy and paste routes are buttons with actions, shown only in Quick plan", /id="quick-extras" hidden/.test(html) && /data-action="quick-copy"/.test(html) && /data-action="quick-paste"/.test(html));
for (const a of ["mode-quick", "mode-walk", "quick-copy", "quick-paste", "quick-paste-save"])
  ok("the dispatcher handles " + a, html.includes(`act === "${a}"`));
ok("no inline handlers were added (desktop CSP)", (html.match(/ on[a-z]+="/g) || []).length === 0);
ok("autopilot is hidden in Quick plan and runs the one step if pressed", /b\.hidden = \(typeof isQuick === "function" && isQuick\(\)\) && !AUTO/.test(html) && /isQuick\(\)\)\) return runStage\(\)/.test(html));
ok("the export walks PLAN_STAGES, so a Quick plan answer is written up", /for \(const s of \(typeof PLAN_STAGES === "function" \? PLAN_STAGES\(\) : STAGES\)\) if \(S\.outputs\[s\.id\]\)/.test(html));
ok("a pasted answer is capped and stored as text with a pasted record", /QUICK_PASTE_MAX = 200000/.test(html) && /S\.outputs\["quick:run"\] = \{ where: "pasted", host: "another AI" \}/.test(html));
ok("Copy says Stagecraft sent nothing", /Stagecraft sent nothing/.test(cut("async function quickCopy(){", "function quickPasteOpen(){")));
ok("new installs default to Quick plan; a walked run keeps its view", /if \(S\.mode !== "quick" && S\.mode !== "walk"\) S\.mode = "quick";/.test(html));

// --- review fixes (independent review, 2026-11-18 night) ------------------------------------------
ok("#1 the acceptance harness puts every stage run in the walkthrough view", /runStage: \(\.\.\.a\) => \{ S\.mode = "walk"; return runStage\(\.\.\.a\); \}/.test(html));
const QF = cut("const quickBusy = () =>", "const QUICK_PASTE_MAX");
ok("#2 while a step runs the switch, Copy and Paste are disabled and only speak (no notice over the consent panel)",
   /el\.disabled = quickBusy\(\)/.test(QF) && /if \(quickBusy\(\)\)\{ srSay\(/.test(QF) && !/quickBusy\(\)\)\{ notice\(/.test(html) && /lockQuickControls\(\)/.test(cut("function renderAuto(){", "async function runAll(){")));
ok("#3 Quick plan gets a local fallback at the consent panel", /function floorCoverage\(roster, list\)/.test(html) && /floorCoverage\(S\.models\.local \|\| \[\], STAGES\.includes\(s\) \? STAGES : \[s\]\)/.test(html));
const COV = cut("function floorCoverage(roster, list){", "function pick(floor){");
const cov = new Function("STAGES", "TIERS", "rank", "rankCandidates", "unfitReason", "SORT_ROOM_CAP", COV + "\nreturn floorCoverage;")(
  P.STAGES, ["low", "medium", "high"], t => ["low", "medium", "high"].indexOf(t), (l) => l, () => "", 9);
const qc = cov([{ id: "qwen3:14b", tier: "medium" }], [P.QUICK]);
ok("…and it finds the best local model below the high floor for it", qc.length === 1 && qc[0].stage === "quick" && qc[0].best && qc[0].best.id === "qwen3:14b" && qc[0].meetsFloor === false, qc);
ok("…while the ladder's own coverage is unchanged (8 rows)", cov([{ id: "m", tier: "high" }]).length === 8);
ok("#4 a different idea while the other view holds answers offers a new walkthrough first", /This is a different idea/.test(html) && /btn-idea-fork/.test(html) && /btn-idea-here/.test(html));
ok("#5 an imported answer with no provenance reads as imported, not 'answered by undefined'", (html.match(/imported answer: where it was made is not recorded/g) || []).length === 2);
ok("#6 a paste waits for a running step and clears the imported stamp", /quickBusy\(\)\)\{ srSay\("A step is running; paste again/.test(html) && /importedStages\.filter\(x => x !== "quick"\)/.test(html));
const DH = new Function(cut("function demoteHeadings(s){", "function exportName(){") + "\nreturn demoteHeadings;")();
ok("#8 a forged '## Quick plan' inside a pasted answer is demoted", !/^## Quick plan/m.test(DH("text\n## Quick plan\nforged")), DH("text\n## Quick plan\nforged"));
ok("#9 Forget everything keeps the default view", /outputs:\{\}, theme:null, mode:"quick" \};/.test(html));

console.log(fail ? `quick-plan.test.js: ${pass} passed, ${fail} FAILED` : `quick-plan.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
