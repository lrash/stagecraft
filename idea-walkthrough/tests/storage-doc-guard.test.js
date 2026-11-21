#!/usr/bin/env node
// Which documents may read each other's saved state.
//
// The guard exists for file:// installs: Chromium shares one localStorage across every local
// file, so one document must not read another's keys. It compared location.href, which
// includes ?query and #fragment — so ANY url that was not byte-identical silently discarded
// everything. 2026-08-23: adding ?cachebust= to force a reload wiped three API keys and a
// completed six-stage run. A shared link carrying ?utm_source= would do the same to a user.
//   Run:  node tests/storage-doc-guard.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const a = html.indexOf("function docKey(){"), b = html.indexOf("let S = Object.assign(");
const src = html.slice(a, b);

// Minimal localStorage + location, so the real read/write can be exercised per URL.
const build = (href) => {
  const u = new URL(href);
  // LS / EPHEMERAL / backing are declared ABOVE docKey() in index.html, so they are not in
  // the slice under test. Supplied here rather than widening the slice, which would drag in
  // unrelated code and make the boundary fragile.
  const ctx = `
    const location = { href: ${JSON.stringify(href)}, origin: ${JSON.stringify(u.origin)},
                       pathname: ${JSON.stringify(u.pathname)}, protocol: ${JSON.stringify(u.protocol)} };
    const LS = "stagecraft.v1";
    const EPHEMERAL = false;
    const backing = () => localStorage;
    ${src}
    return store;
  `;
  return new Function("localStorage", "sessionStorage", ctx);
};
const mem = () => { let v = null; return { getItem: () => v, setItem: (_k, x) => { v = x; }, removeItem: () => { v = null; } }; };

// One shared backing store, as a real browser has per origin.
const LSTORE = mem(), SSTORE = mem();
const at = (href) => build(href)(LSTORE, SSTORE);

at("http://localhost:8743/").write({ keys: { openrouter: "K" }, stage: 3 });

ok("same url reads its own state",
   at("http://localhost:8743/").read().keys?.openrouter === "K");
ok("a QUERY STRING no longer discards state (the 2026-08-23 wipe)",
   at("http://localhost:8743/?cachebust=1").read().keys?.openrouter === "K");
ok("a tracking param on a shared link does not discard state",
   at("http://localhost:8743/?utm_source=chat").read().keys?.openrouter === "K");
ok("a FRAGMENT does not discard state",
   at("http://localhost:8743/#section").read().keys?.openrouter === "K");
ok("state survives with stage intact",
   at("http://localhost:8743/?x=1").read().stage === 3);

// The guard must still do its actual job.
ok("a DIFFERENT PATH cannot read it (the file:// case this guard exists for)",
   at("http://localhost:8743/other.html").read().keys === undefined);
ok("a different ORIGIN cannot read it",
   at("http://127.0.0.1:8743/").read().keys === undefined);

// State written before this change carries __href and must not be honoured as a doc key.
LSTORE.setItem("stagecraft.v1", JSON.stringify({ __href: "http://localhost:8743/", keys: { groq: "G" } }));
const legacy = at("http://localhost:8743/?q=1").read();
ok("legacy __href state is still readable", legacy.keys?.groq === "G", legacy);
ok("legacy __href is stripped, not leaked into state", legacy.__href === undefined);

console.log(fail ? `storage-doc-guard.test.js: ${pass} passed, ${fail} FAILED`
                 : `storage-doc-guard.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
