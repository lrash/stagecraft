#!/usr/bin/env node
// Regression tests for where Stagecraft keeps its state.
// 2026-08-20 review, HIGH: Chromium serialises every file:// document into ONE Web Storage
// partition, so an API key written to localStorage by a double-clicked index.html is readable
// by any other .html file the user opens from disk. The store now picks its backing by
// protocol and stamps the document URL. Source is lifted from index.html so it cannot drift.
//   Run:  node tests/storage.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

const a = html.indexOf('const LS = "stagecraft.v1";');
const b = html.indexOf("let S = Object.assign(", a);
if (a < 0 || b < 0) { console.error("could not locate the store block in index.html"); process.exit(1); }
const SRC = html.slice(a, b);

// A minimal Web Storage stand-in. Two of them, so "did the key leak between documents?"
// is a question the test can actually ask.
function makeStorage(){
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null),
           setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k),
           _raw: m };
}
const build = new Function("location", "localStorage", "sessionStorage",
  SRC + "\nreturn { store, EPHEMERAL, backing };");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => cond
  ? pass++
  : (fail++, console.log("FAIL  " + name + (detail ? "\n      " + detail : "")));

/* --- served from a real origin: localStorage, because same-origin isolation is genuine --- */
{
  const ls = makeStorage(), ss = makeStorage();
  const A = build({ protocol:"http:", href:"http://localhost:8743/index.html", origin:"http://localhost:8743" }, ls, ss);
  ok("a served page is not ephemeral", A.EPHEMERAL === false);
  A.store.write({ keys:{ openrouter:"sk-or-v1-secret" } });
  ok("a served page persists to localStorage", ls._raw.size === 1 && ss._raw.size === 0);
  ok("a served page reads its own state back",
     A.store.read().keys.openrouter === "sk-or-v1-secret");
}

/* --- opened as a file: sessionStorage, which dies with the tab ------------------------- */
{
  const ls = makeStorage(), ss = makeStorage();
  const A = build({ protocol:"file:", href:"file:///home/u/Downloads/index.html", origin:"null" }, ls, ss);
  ok("a double-clicked page is ephemeral", A.EPHEMERAL === true);
  A.store.write({ keys:{ openrouter:"sk-or-v1-secret" } });
  ok("the key never reaches localStorage, which file:// documents share",
     ls._raw.size === 0 && ss._raw.size === 1,
     "localStorage=" + ls._raw.size + " sessionStorage=" + ss._raw.size);
  ok("the page still works within its own tab",
     A.store.read().keys.openrouter === "sk-or-v1-secret");

  // The concrete attack from the review: a DIFFERENT local file, same shared partition.
  // Even if something puts state in the shared localStorage, the href stamp refuses it.
  ls.setItem("stagecraft.v1", JSON.stringify({ __href:"file:///home/u/Downloads/index.html", keys:{ openrouter:"sk-or-v1-secret" } }));
  const B = build({ protocol:"file:", href:"file:///home/u/Downloads/some-other-tool.html", origin:"null" }, ls, makeStorage());
  ok("state stamped by a different document is refused, not loaded",
     Object.keys(B.store.read()).length === 0, JSON.stringify(B.store.read()));
}

/* --- the stamp is internal bookkeeping and must not leak into application state -------- */
{
  const A = build({ protocol:"http:", href:"http://x/index.html", origin:"http://x" }, makeStorage(), makeStorage());
  A.store.write({ keys:{}, stage:2 });
  const r = A.store.read();
  ok("__href is stripped on read", !("__href" in r) && r.stage === 2);
}

/* --- clear() must empty whichever store was used, and the other one too ---------------- */
{
  const ls = makeStorage(), ss = makeStorage();
  const A = build({ protocol:"file:", href:"file:///f.html", origin:"null" }, ls, ss);
  A.store.write({ keys:{ groq:"gsk_x" } });
  ls.setItem("stagecraft.v1", "{}");            // a leftover from an earlier, served run
  A.store.clear();
  ok("Forget everything clears both backing stores",
     ls._raw.size === 0 && ss._raw.size === 0);
}

/* --- a storage that throws (private mode, quota) must not take the page down ----------- */
{
  const dead = { getItem(){ throw new Error("denied"); }, setItem(){ throw new Error("denied"); },
                 removeItem(){ throw new Error("denied"); } };
  const A = build({ protocol:"http:", href:"http://x/", origin:"http://x" }, dead, dead);
  let threw = false;
  try { A.store.write({ keys:{} }); A.store.read(); A.store.clear(); } catch { threw = true; }
  ok("a refusing storage degrades to not-remembered rather than throwing", threw === false);
}

console.log(pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);
