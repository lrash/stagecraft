#!/usr/bin/env node
// Regression test for the 2026-08-20 LOW finding: a static file cannot send X-Frame-Options
// and <meta> CSP frame-ancestors is ignored, so a hosted copy is framable — on a page that
// auto-opens its key prompt for first-time visitors. The guard is the only defence, so it is
// tested rather than eyeballed. Source is lifted from index.html so the test cannot drift.
//   Run:  node tests/frame.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

const a = html.indexOf("if (window.top !== window.self){");
const b = html.indexOf("}", html.indexOf("throw new Error(\"framed\")"));
if (a < 0 || b < 0) { console.error("could not locate the frame guard in index.html"); process.exit(1); }
const GUARD = html.slice(a, b + 1);
const run = new Function("window", "document", GUARD);

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? pass++ : (fail++, console.log("FAIL  " + name));

// framed: top and self are different objects
{
  let wrote = null;
  const w = { top: { id: "attacker" }, self: { id: "stagecraft" } };
  const d = { documentElement: { set innerHTML(v){ wrote = v; } } };
  let threw = false;
  try { run(w, d); } catch (e) { threw = e.message === "framed"; }
  ok("framed: execution is halted", threw);
  ok("framed: the document is replaced", typeof wrote === "string" && wrote.length > 0);
  ok("framed: no key form is left on screen", !/input|password|prov/i.test(wrote || ""));
  ok("framed: the reason is explained", /own tab/i.test(wrote || ""));
}

// top-level: top === self, the page must run untouched
{
  let wrote = null;
  const w = {}; w.top = w; w.self = w;
  const d = { documentElement: { set innerHTML(v){ wrote = v; } } };
  let threw = false;
  try { run(w, d); } catch (e) { threw = true; }
  ok("top-level: nothing is thrown", !threw);
  ok("top-level: the document is untouched", wrote === null);
}

console.log(pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);
