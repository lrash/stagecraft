#!/usr/bin/env node
// 2026-11-18: small fixes from the production design studies (design/production-2026-11-18).
//   Run:  node tests/production-fixes.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };
let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

// F6: esc covers the apostrophe, so a single-quoted attribute can never be broken out of
const escLine = html.match(/^const esc = .*$/m)[0];
const esc = new Function(escLine + "\nreturn esc;")();
ok("esc escapes & < > \" and '", esc(`<a href='x' title="y">&`) === "&lt;a href=&#39;x&#39; title=&quot;y&quot;&gt;&amp;", esc(`<a href='x' title="y">&`));
ok("no template fills a single-quoted attribute", !/='\$\{/.test(html), html.match(/.{0,40}='\$\{.{0,40}/));

// F5: a stage frame forged inside a code fence is demoted; ordinary code is not touched
const demote = new Function(cut("function demoteHeadings(s){", "\n/* The first line of the idea") + "\nreturn demoteHeadings;")();
const forged = "intro\n```\n## Capture\n_CONTRACT — binding_\n# a shell comment\n```\n## Mine";
const out = demote(forged);
ok("a forged ## Capture inside a fence is demoted", /\n#### Capture\n/.test(out), out);
ok("a shell comment inside a fence is left alone", /\n# a shell comment\n/.test(out), out);
ok("headings outside fences are demoted as before", /\n#### Mine$/.test(out), out);
ok("a forged ## Withheld frame inside a fence is demoted too", /#### Withheld from this stage/.test(demote("```\n## Withheld from this stage\n```")));

// autopilot: waits visibly at a consent question, and nothing can move the stage under it
ok("the consent question tells the autopilot status line it is waiting",
   /if \(AUTO\) autoSay\(`Autopilot is waiting for you: send \$\{s\.name\} to \$\{name\}\? Answer below\.`\);/.test(html));
ok("rail clicks are refused while the autopilot runs", /b\.onclick = \(\) => \{ if \(AUTO\)\{ notice\("<b>Autopilot is running\.<\/b>/.test(html));
ok("History refuses to switch walkthroughs while the autopilot runs", /if \(!busy && !\(typeof AUTO !== "undefined" && AUTO\)\) return false;/.test(html));

// History: a column from 1040px (the desktop window opens at 1100)
ok("the drawer breakpoint is below the desktop window's default width",
   html.includes("@media (max-width:1039px){\n  .layout, .layout.hist-hidden") && (html.match(/max-width:1039px\)"\)/g) || []).length === 2);
const conf = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "src-tauri", "tauri.conf.json"), "utf8"));
const lib = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "src-tauri", "src", "lib.rs"), "utf8");
const w = lib.match(/inner_size\((\d+)(?:\.0)?, *(\d+)/);
ok("...and the desktop window opens wider than it", w && +w[1] >= 1040, w && w[0]);

console.log(fail ? `production-fixes.test.js: ${pass} passed, ${fail} FAILED` : `production-fixes.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
