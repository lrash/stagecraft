#!/usr/bin/env node
// Regression tests for the 2026-08-21 live-run defects: a reasoning model's <think> scratchpad
// was saved into the write-up, a reply cut off mid-reasoning was rendered as a finished stage,
// and every download landed on the same filename. Source is lifted from index.html.
//   Run:  node tests/output.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
function slice(from, to){
  const a = html.indexOf(from), b = html.indexOf(to, a);
  if (a < 0 || b < 0) { console.error("could not locate " + JSON.stringify(from)); process.exit(1); }
  return html.slice(a, b);
}
const THINKING = slice("const THINK_PAIR", "/* A response that came back");
const NAMING   = slice("function exportName(){", "/* ---------- wiring");

let pass = 0, fail = 0;
const ok = (name, cond, got) => cond ? pass++ : (fail++, console.log("FAIL  " + name + (got !== undefined ? "\n      got: " + JSON.stringify(got) : "")));

// ---- scratchpad stripping ----
{
  const T = new Function(THINKING + "\nreturn { stripThinking, looksTruncated };")();
  const closed = "<think>I should list four parts.</think>\n\n1. Storage\n2. Sync";
  ok("a closed <think> block is removed", T.stripThinking(closed) === "1. Storage\n2. Sync", T.stripThinking(closed));
  ok("a closed block is NOT truncation", !T.looksTruncated(closed, T.stripThinking(closed)));
  ok("<thinking> and <reasoning> too", T.stripThinking("<reasoning>x</reasoning>answer") === "answer");
  ok("plain output is untouched", T.stripThinking("just an answer") === "just an answer");

  // the 2026-08-21 case: opened, never closed, cut off mid-sentence
  const cut = "<think>Let's check the exact wording requirement: \"For each part say, in one line, what";
  ok("an unclosed <think> is truncation", T.looksTruncated(cut, T.stripThinking(cut)));
  ok("an empty reply is truncation", T.looksTruncated("", T.stripThinking("")));
}

// ---- download naming ----
{
  const STAGES = ["capture","diverge","structure","deepen","critique","consolidate"].map(id => ({ id }));
  const S = { outputs:{}, exportN:0 };
  const N = new Function("S", "STAGES", "save", NAMING + "\nreturn { exportName, abbrevModel };")(S, STAGES, () => {});

  ok("vendor prefix and :free are dropped",
     N.abbrevModel("nvidia/nemotron-3-super-120b-a12b:free") === "nemotron-3-super", N.abbrevModel("nvidia/nemotron-3-super-120b-a12b:free"));
  ok("a short id survives whole", N.abbrevModel("groq/compound-mini") === "compound-mini", N.abbrevModel("groq/compound-mini"));
  ok("ollama :latest is dropped", N.abbrevModel("llama3.2:latest") === "llama3.2", N.abbrevModel("llama3.2:latest"));
  ok("a missing model is harmless", N.abbrevModel(undefined) === "");

  S.outputs.capture = "x";   S.outputs["capture:model"]   = "groq/compound-mini";
  S.outputs.structure = "x"; S.outputs["structure:model"] = "qwen/qwen3.6-27b";
  const a = N.exportName();
  ok("names the models used", /compound-mini/.test(a) && /qwen3.6-27b/.test(a), a);
  ok("records progress", /2of6/.test(a), a);
  ok("is versioned", /-v1-/.test(a), a);
  ok("ends .md", /\.md$/.test(a), a);

  const b = N.exportName();
  ok("a second download does NOT collide", a !== b, [a, b]);
  ok("the counter advances", /-v2-/.test(b), b);
}

console.log(pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);
