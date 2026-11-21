#!/usr/bin/env node
// 2026-08-22: the first complete run produced a write-up with 13 top-level headings instead of 7.
// Deepen emitted its own "## " headings and the exporter uses "## " for stage names, so six of
// Deepen's headings became siblings of the stages. "## 4 - Integrity & Restore Testing" sat beside
// "## Critique" and nothing could tell where a stage ended — including the script that scored it.
// Model output is untrusted input to a structured document.
//   Run:  node tests/export-structure.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const a = html.indexOf("function demoteHeadings(s){"), b = html.indexOf("function exportName(){");
const D = new Function(html.slice(a, b) + "\nreturn demoteHeadings;")();

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

ok("a model's ## becomes ####", D("## Inventory") === "#### Inventory", D("## Inventory"));
ok("a lone # becomes ###",      D("# Top") === "### Top");
ok("###### cannot exceed 6",    D("###### Deep") === "###### Deep", D("###### Deep"));
ok("##### clamps at 6",         D("##### Five") === "###### Five", D("##### Five"));
ok("body text is untouched",    D("Just a sentence.") === "Just a sentence.");
ok("a mid-line # is not a heading", D("use #4 bolts") === "use #4 bolts");
ok("no space after # is not a heading", D("#hashtag") === "#hashtag");

// the real-world case: six headings in one stage
const deepen = "Intro line\n\n## 1 - Inventory\ntext\n\n## 2 - Design\ntext\n\n## 3 - Automation\ntext";
const out = D(deepen);
ok("every heading in a stage is demoted", (out.match(/^## [^#]/gm) || []).length === 0, out.match(/^#+ .*/gm));
ok("all six survive as sub-headings", (out.match(/^#### /gm) || []).length === 3);

// shell comments inside fences must not be mangled
const fenced = "Run this:\n\n```bash\n# back up the volume\ndocker run --rm -v v:/d alpine tar cf - /d\n```\n\n## After";
const f = D(fenced);
ok("a # comment inside a fence is left alone", f.includes("\n# back up the volume\n"), f);
ok("but a heading after the fence is demoted", f.includes("#### After"));

// multiple fences
const two = "```\n# one\n```\n## Mid\n```\n# two\n```\n# End";
const t2 = D(two);
ok("multiple fences handled", t2.includes("\n# one\n") && t2.includes("\n# two\n") && t2.includes("#### Mid") && t2.includes("### End"), t2);

ok("null/undefined is safe", D(undefined) === "" && D(null) === "");

console.log(pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);
