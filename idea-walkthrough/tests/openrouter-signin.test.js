#!/usr/bin/env node
// 2026-11-18: "Sign in with OpenRouter" (OAuth PKCE in Rust, desktop/src-tauri/src/oauth.rs).
// The page only asks Rust to do it and shows the outcome; it never handles the code or the key.
//   Run:  node tests/openrouter-signin.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const root = path.join(__dirname, "..", "..");
const rd = p => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

ok("the bridge calls openrouter_sign_in with no arguments (nothing secret crosses IPC from the page)",
   /openrouterSignIn: \(\) => invoke\("openrouter_sign_in"\),/.test(html));
ok("the button is offered for OpenRouter only, on the desktop, before any keystore question",
   /p === "openrouter" && SCDs && SCDs\.openrouterSignIn && !ch\s*\n\s*\? `<div class="row"><button class="btn" data-cloud-signin="\$\{p\}"\$\{CLOUD_UI\.signing \? " disabled" : ""\}>Sign in with OpenRouter<\/button>/.test(html));
ok("it says what will happen in plain words", /Opens openrouter\.ai in your browser\. Sign in \(Google, GitHub or email\), press <b>Authorize<\/b>, then come back here\./.test(html));
ok("pasting a key stays available", /Or paste a key instead:/.test(html) && /data-cloud-save="\$\{p\}">Check and save/.test(html));
ok("the click goes through the panel's delegated handler", /on\("data-cloud-signin", p => cloudSignIn\(p\)\);/.test(html));
const fn = html.slice(html.indexOf("async function cloudSignIn(p){"), html.indexOf("async function cloudKeyResult("));
ok("every Rust refusal has words, and says nothing was saved",
   ["timeout", "declined", "state-mismatch", "exchange-failed", "unreachable", "open-failed", "cloud-off", "not-enabled"].every(k => fn.includes((k.includes("-") ? '"' + k + '"' : k) + ":"))
   && /Nothing was saved\. Try again, or paste a key\./.test(fn));
ok("a stored key goes through the same outcome handling as a pasted one", /await cloudKeyResult\(p, kc, ""\);/.test(fn) && /await cloudKeyResult\(p, kc, keep\);/.test(html));
ok("one sign-in at a time, and the button is disabled while it waits", /if \(CLOUD_UI\.signing\) return;\s*CLOUD_UI\.signing = true;/.test(fn));
ok("the new refusals have words: busy, no keychain, locked keychain", /busy: "A sign-in is already waiting/.test(fn) && /"no-keystore": "This computer has no system keychain/.test(fn) && /locked: "Your system keychain is locked/.test(fn));
ok("no code, verifier or key is ever read by the page", !/code_verifier|code_challenge|sk-or-/.test(fn));

// Rust side: registered, permitted only after opt-in, and pinned to the documented flow
const build = rd("desktop/src-tauri/build.rs"), cloud = JSON.parse(rd("desktop/src-tauri/capabilities-runtime/cloud.json"));
const main = JSON.parse(rd("desktop/src-tauri/capabilities/main.json")), oauth = rd("desktop/src-tauri/src/oauth.rs");
ok("the command is in the app manifest (R-72)", /"openrouter_sign_in",/.test(build));
ok("...and granted only by the runtime cloud capability (after opt-in), not the v1 one",
   cloud.permissions.includes("allow-openrouter-sign-in") && !JSON.stringify(main).includes("openrouter-sign-in"));
ok("the documented URLs, compiled in", /AUTH_URL: &str = "https:\/\/openrouter\.ai\/auth";/.test(oauth) && /EXCHANGE_URL: &str = "https:\/\/openrouter\.ai\/api\/v1\/auth\/keys";/.test(oauth));
ok("loopback only, S256, a state, five minutes", /bind\("127\.0\.0\.1:0"\)/.test(oauth) && /code_challenge_method=S256&state=/.test(oauth) && /from_secs\(300\)/.test(oauth));

console.log(fail ? `openrouter-signin.test.js: ${pass} passed, ${fail} FAILED` : `openrouter-signin.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
