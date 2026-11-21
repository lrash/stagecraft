#!/usr/bin/env node
// The app must not claim work is saved when it is not.
//
// 2026-08-23 review, MEDIUM: store.write() had an empty catch and no return value, and ~20
// call sites discarded the result. read() returned {} on throw — indistinguishable from a
// first visit. Meanwhile the footer said "Kept in this browser's storage" and the reminder
// said "It is kept only in this browser", both rendered from memory. On a browser that blocks
// site data, every save threw and the app told the user their work was safe.
//   Run:  node tests/storage-honesty.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const a = html.indexOf("function docKey(){"), b = html.indexOf("const PERSISTENT = store.usable();");
ok("located the store", a > 0 && b > a);

const mk = (backing) => new Function("localStorage", "sessionStorage", `
  const location = { href:"http://x/", origin:"http://x", pathname:"/", protocol:"http:" };
  const LS = "stagecraft.v1"; const EPHEMERAL = false;
  const backing = () => localStorage;
  ${html.slice(a, b)}
  return store;
`)(backing, backing);

// A working store.
const good = (() => { const m = {}; return { getItem:k=>k in m?m[k]:null, setItem:(k,v)=>{m[k]=String(v);}, removeItem:k=>{delete m[k];} }; })();
const G = mk(good);
ok("write reports success on a working store", G.write({a:1}) === true);
ok("usable() is true on a working store",      G.usable() === true);

// A store that throws on write — Chrome's block-all-site-data.
const blocked = { getItem:()=>{throw new Error("SecurityError");}, setItem:()=>{throw new Error("SecurityError");}, removeItem:()=>{} };
const B = mk(blocked);
ok("write reports FAILURE rather than swallowing it", B.write({a:1}) === false);
ok("usable() is false when storage is blocked",       B.usable() === false);
ok("read still degrades safely to {}",                JSON.stringify(B.read()) === "{}");

// A store that accepts writes but never persists them — setItem succeeds, getItem lies.
const amnesiac = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
const A = mk(amnesiac);
ok("usable() catches a store that accepts but does not persist", A.usable() === false);

// The UI must be conditioned on it, not on hope.
ok("PERSISTENT is probed at boot",       /const PERSISTENT = store\.usable\(\);/.test(html));
ok("the footer branches on PERSISTENT",  /:\s*PERSISTENT\s*\n?\s*\?/.test(html) || /PERSISTENT[\s\S]{0,80}Kept in this browser/.test(html));
ok("and says so plainly when it cannot save", /not letting Stagecraft save anything/.test(html));

console.log(fail ? `storage-honesty.test.js: ${pass} passed, ${fail} FAILED`
                 : `storage-honesty.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
