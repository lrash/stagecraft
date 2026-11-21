#!/usr/bin/env node
// Cloud providers wait long enough for a free high-tier model, and less than Rust's own cap.
// 2026-11-18: Reconcile on a free 550B model takes 100–145 s; the 120 s default cut it off in the app.
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const rust = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "src-tauri", "src", "cloud.rs"), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));
const rustCap = Number((rust.match(/\.timeout\(Duration::from_secs\((\d+)\)\)/) || [])[1]) * 1000;
ok("Rust's request cap found", rustCap > 0, rustCap);
const m = html.match(/\nconst CLOUD_TIMEOUT_MS = (\d+);[\s\S]{0,200}for \(const p of \["openrouter", "groq", "gemini"\]\) if \(PROVIDERS\[p\]\) PROVIDERS\[p\]\.timeoutMs = CLOUD_TIMEOUT_MS;/);
const ms = m ? Number(m[1]) : null;
ok("cloud providers get their own timeout after PROVIDERS", ms !== null);
ok("it waits at least 4 minutes", ms >= 240000, ms);
ok("it stops before Rust's cap, so the page names the timeout", ms < rustCap, [ms, rustCap]);
ok("it sits outside the R-12 pinned range (PROVIDERS up to 'local model facts')",
   html.indexOf("const CLOUD_TIMEOUT_MS") > html.indexOf("/* ---------- local model facts"));
// It takes effect: evaluate PROVIDERS' neighbourhood with the override and read the value back.
{
  const PROVIDERS = { openrouter: {}, groq: {}, gemini: {}, local: { timeoutMs: 600000 } };
  const a = html.indexOf("const CLOUD_TIMEOUT_MS"), b = html.indexOf("/* ---------- quota ledger");
  new Function("PROVIDERS", html.slice(a, b))(PROVIDERS);
  ok("override applies to every cloud provider", ["openrouter","groq","gemini"].every(p => PROVIDERS[p].timeoutMs === ms));
  ok("local keeps its own timeout", PROVIDERS.local.timeoutMs === 600000);
}
console.log(`cloud-timeout: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
