#!/usr/bin/env node
// DESIGN-desktop A-34 (§9): the §2 spine block, the crate floors and the devtools ban, as one
// test, so the agent gate runs them with every `node --test tests/` instead of by hand.
//  R-4  `s.status` is stamped in exactly one place (contextSoFar's join)
//  R-5  the page loads nothing external
//  R-8  seven stages with the §1 floors (PROPOSAL 2026-11-17: six until Review was added)
//  R-41 no inline on…= handlers
//  R-74 the page never asks for OLLAMA_ORIGINS=* or OLLAMA_HOST=0.0.0.0
//  R-78 Cargo.lock: tauri >= 2.11.1, tauri-plugin-http >= 2.5.7
//  R-79 Cargo.toml never names `devtools`
//  R-83 no copy says the user needs (or is required to use) the cloud
//  R-97 the desktop cloud destination line names provider and tier, never a model id
//  R-108 every provider's data-use line is dated as checked against its terms
//   Run:  node tests/desktop-spine.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const tauriDir = path.join(__dirname, "..", "..", "desktop", "src-tauri");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));
const lines = re => html.split("\n").filter(l => re.test(l));
const count = re => (html.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length;

// The §2 spine block. Its greps count matching lines (grep -c), so these do too.
ok("R-4: s.status is stamped on exactly one line", lines(/(^|[^A-Za-z0-9_])s\.status/).length === 1, lines(/(^|[^A-Za-z0-9_])s\.status/));
ok("R-5: no external <link|script|img|iframe>", lines(/<(link|script|img|iframe)[^>]*https?:\/\//).length === 0);
const ladder = html.match(/id:"[a-z]+", name:"[A-Za-z ]+", floor:"[a-z]+"/g) || [];   // names may have a space ("Check facts")
// PROPOSAL 2026-11-17 (branch proposal-review-stage): R-8 amended from six to seven stages, Review
// last at high. Evidence: DESIGN-desktop R-8 and the Review comment in index.html.
ok("R-8: eight stages (Check facts added 2026-11-18 at the owner's request)", ladder.length === 8, ladder);
ok("R-8: ...with the §1 floors, in order",
   ladder.map(s => s.match(/id:"([a-z]+)".*floor:"([a-z]+)"/).slice(1).join(":")).join() ===
   "capture:medium,diverge:low,structure:medium,deepen:high,critique:high,reconcile:high,review:high,verify:high", ladder);
ok("R-41: zero inline on…= attributes", lines(/ on[a-z]+="/).length === 0, lines(/ on[a-z]+="/));
ok("R-74: never asks for OLLAMA_ORIGINS=* or OLLAMA_HOST=0.0.0.0", count(/OLLAMA_ORIGINS=\*|OLLAMA_HOST=0\.0\.0\.0/) === 0);
ok("R-83: no copy says cloud is needed or required",
   count(/\bneeds? (a |the )?(free )?cloud|cloud is required|requires? (a |the )?cloud/i) === 0,
   html.match(/.{0,60}(\bneeds? (a |the )?(free )?cloud|cloud is required|requires? (a |the )?cloud).{0,60}/i));

// R-97 (and R-1): on the desktop a cloud destination line names the provider and the tier and
// never a model id; model ids appear only in the receipt and the model list.
{
  const a = html.indexOf("if (going && deskCloud && !PROVIDERS[going.provider].keyless){");
  const b = html.indexOf("} else\n  $(\"destination\").innerHTML = going", a);
  const branch = a < 0 || b < 0 ? "" : html.slice(a, b);
  ok("R-97: the desktop cloud destination branch exists", branch.length > 0);
  ok("R-97: ...names the provider and the tier", /PROVIDERS\[going\.provider\]\.name/.test(branch) && /\$\{esc\(going\.tier\)\}/.test(branch), branch.slice(0, 300));
  ok("R-97: ...and never the model id", !/going\.(id|model)\b/.test(branch), branch.match(/going\.(id|model)\b.{0,40}/));
}

// R-78: the crate floors, read from Cargo.lock (skipped, not failed, if the desktop tree is absent).
const lockPath = path.join(tauriDir, "Cargo.lock");
if (fs.existsSync(lockPath)) {
  const lock = fs.readFileSync(lockPath, "utf8");
  const ver = name => { const m = lock.match(new RegExp('\\nname = "' + name.replace(/[-]/g, "\\-") + '"\\nversion = "([0-9.]+)"')); return m && m[1].split(".").map(Number); };
  const atLeast = (v, min) => { if (!v) return false; for (let i = 0; i < 3; i++) { if (v[i] !== min[i]) return v[i] > min[i]; } return true; };
  ok("R-78: Cargo.lock has tauri >= 2.11.1", atLeast(ver("tauri"), [2, 11, 1]), ver("tauri"));
  ok("R-78: Cargo.lock has tauri-plugin-http >= 2.5.7", atLeast(ver("tauri-plugin-http"), [2, 5, 7]), ver("tauri-plugin-http"));
  const toml = fs.readFileSync(path.join(tauriDir, "Cargo.toml"), "utf8");
  ok("R-79: Cargo.toml never names devtools", !/devtools/.test(toml));
} else {
  console.log("skip  R-78/R-79: no desktop/src-tauri/Cargo.lock next to the page");
}

// R-108: the data-use lines carry the date they were checked (design/TERMS-CHECK-2026-11-17.md).
const termsDate = (html.match(/const CLOUD_TERMS_CHECKED = "(\d{4}-\d{2}-\d{2})";/) || [])[1];
ok("R-108: CLOUD_TERMS_CHECKED is a date", !!termsDate);
const termsBlock = (html.match(/const CLOUD_TERMS = \{([\s\S]*?)\n\};/) || [])[1] || "";
for (const p of ["openrouter", "groq", "gemini"]) {
  const m = termsBlock.match(new RegExp(p + ':\\s*\\{\\s*line: "([^"]+)",\\s*src: "(https://[^"]+)", checked: "([0-9-]+)"'));
  ok(`R-108: ${p} has a line, an https source and a checked date`, !!m && m[3] === termsDate, m && m.slice(1));
}
ok("R-108: no 'not yet checked' suffix can show", termsDate && !/Not yet checked/.test(html.replace(/\(CLOUD_TERMS_CHECKED \? "" : [^)]*\)/, "")));

// Accuracy rubric 2026-11-17: Capture asks whose it is and the limits first; Critique may not invent the user.
ok("rubric D: Capture's UNKNOWN asks who this is for and the limits first",
   /- UNKNOWN: the five most important things not established about this idea[^\n]*then[^\n]*two more: who this is for[^\n]*budget, time available/.test(html));
ok("Capture's headings stand alone, so the contract does not repeat the prompt",
   /\nSOURCE FACTS\nMEDIUM\nMUST\nMUST NOT\nUNKNOWN\nOUT OF SCOPE\n/.test(html) && /do not copy these descriptions into your answer/.test(html));
ok("rubric B: Critique forbids inventing facts about the author or users",
   /Do NOT invent facts about the author or the people who will use this/.test(html));
ok("rubric B: Reconcile treats a conditional objection as an objection, not a claim",
   /An objection is not a claim\. Critique states premises as conditions/.test(html));
ok("rubric B: Reconcile flags an UNKNOWN that a later stage answered or turned into a MUST",
   /An UNKNOWN in the contract is still unknown\. A line that answers it, decides it, or relabels it as a MUST is UNSUPPORTED/.test(html));
ok("rubric B: Capture's OUT OF SCOPE is 'not asked for', never an exclusion",
   /- OUT OF SCOPE: [^\n]*Start each line "Not asked for:"\. These are not exclusions/.test(html));
console.log(`desktop-spine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
