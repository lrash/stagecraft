#!/usr/bin/env node
// The divergence check warns before a stage spends one of a scarce daily allowance. It must
// cost nothing (no model call) and, far more important, must not cry wolf: a legitimate
// deepening shares few words with the ORIGINAL sentence but many with the later stages, so
// checking against the whole run rather than the idea alone is the load-bearing part.
// Corpus below is condensed from the real 2026-08-21 Obsidian run in ref_docs.
//   Run:  node tests/diverge.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const a = html.indexOf("const STOPWORDS"), b = html.indexOf("/* ---------- the six stages");
const SRC = html.slice(a, b);

const IDEA = "Would Obsidian be a good Agentic agent profile manager like Claude for settings, skill, wiki, to-dos, etc. to be a portable project framework to another platform?";
const OUT = {
  capture: "Obsidian could serve as an agentic profile manager by storing an agent's settings, skills, knowledge base and to-do lists within its markdown vaults, making the configuration portable and transferable to other platforms that read the same files.",
  diverge: "Store JSON-encoded agent configs in a vault folder. Use the Dataview plugin to query markdown tables defining skill parameters. Sync the vault with a Git repository via CI/CD. Leverage the custom URI scheme to trigger actions. Create a bidirectional sync plugin writing agent state back into notes. Export the vault as a portable zip.",
  deepen:  "What bidirectional sync mechanism (WebSocket plugin, file-system watcher with conflict resolution, Git-based CRDT) will ensure runtime state changes are persisted back to the vault without data loss or duplication? Which granular permission model will prevent exfiltration of sensitive agent credentials?"
};
// Real corpora measured from the 2026-08-21 run: 88 unique content words after Capture, 126
// after Diverge, 321 after Structure, 407 after Deepen. The check must stay SILENT below
// DIVERGE_MIN_CORPUS, so the fixture below is padded to a realistic post-Structure size —
// judging a steering note against an 88-word vocabulary flagged nearly all of them.
OUT.structure = `Phase 1 foundation: define the vault schema, folder layout and naming rules for
  agent settings, skills, knowledge notes and tasks, including front-matter keys, identifiers and
  versioning. Phase 2 runtime: specify how a running agent loads, caches and validates that
  configuration, how plugin functions are invoked, and how malformed or partially written files
  are rejected rather than executed. Phase 3 synchronisation: choose a write-back mechanism and
  define conflict resolution, ordering guarantees, retry behaviour and duplicate suppression.
  Phase 4 portability: define an export format, an asset manifest, and a conformance suite that a
  downstream framework must pass. Phase 5 security: enumerate secrets, encryption boundaries,
  capability tokens and audit requirements. Phase 6 performance: incremental indexing, lazy
  loading, benchmark targets and pivot cost at ten thousand notes.
  Open risks recorded during structuring: silent corruption when an editor saves while the
  runtime writes; divergent histories across machines sharing one repository; credential leakage
  through unencrypted attachments; stale indexes after bulk renames; schema drift between agent
  versions; latency regressions from unbounded queries; migration failures where semantic links
  between skills and knowledge nodes cannot be preserved across frameworks.`;

const STAGES = ["capture","diverge","structure","deepen","critique","consolidate"].map(id => ({ id }));
const S = { idea: IDEA, outputs: OUT };
const D = new Function("S", "STAGES", SRC + "\nreturn { divergence, words, runCorpus };")(S, STAGES);

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

// must NOT fire — these are the run getting deeper, which is the whole point of the app
const KEEP = [
  "How would the bidirectional sync plugin resolve conflicts when two agents write the same markdown note at once?",
  "Focus on the permission model for credentials stored in vault front-matter, and what an exfiltration path looks like.",
  "Compare the Git repository sync against the Dataview plugin approach for portability between platforms."
];
for (const k of KEEP){
  const d = D.divergence(k);
  ok("deepening is not flagged: " + k.slice(0, 44) + "…", !d.diverging, { overlap: +d.overlap.toFixed(2), novel: d.novel });
}

// SHOULD fire — a different subject entirely
const FORK = [
  "Actually what about scheduling nightly backups of my photo library to Backblaze using cron jobs?",
  "Switch topic: design a sourdough hydration calculator for bakers with oven temperature curves."
];
for (const f of FORK){
  const d = D.divergence(f);
  ok("new subject is flagged: " + f.slice(0, 44) + "…", d.diverging, { overlap: +d.overlap.toFixed(2), novel: d.novel });
}

// too little to judge — stay silent rather than guess
for (const s of ["more detail", "go deeper", ""]){
  ok("short input stays silent: " + JSON.stringify(s), !D.divergence(s).diverging);
}
ok("no model is consulted (pure string work)", !/fetch\(|await /.test(SRC));

// 2026-08-21 HIGH: with only ~88 unique content words after Capture, essentially every
// legitimate steering note scored below the overlap threshold and was flagged. A false positive
// is worse than a miss here — it teaches the user to click through the warning.
{
  const tiny = { idea: IDEA, outputs: { capture: OUT.capture } };
  const T = new Function("S", "STAGES", SRC + "\nreturn { divergence, runCorpus };")(tiny, STAGES);
  ok("a small corpus is below the floor", T.runCorpus().size < 150, T.runCorpus().size);
  ok("so the check stays silent early on",
     !T.divergence("Actually what about nightly backups of my photo library to Backblaze with cron?").diverging);
}
ok("the armed corpus is above the floor", D.runCorpus().size >= 150, D.runCorpus().size);

console.log(pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);
