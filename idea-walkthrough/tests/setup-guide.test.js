#!/usr/bin/env node
// 2026-11-18: first-run set-up guide (owner: "intuitive setup for non-technical users"; use paid
// subscriptions if the user has them, else free credits). Honest about subscriptions; the
// connection itself is the existing opt-in and "Sign in with OpenRouter".
//   Run:  node tests/setup-guide.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };
let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));
const W = cut("/* ---------- first-run set-up guide", "/* ---------- provider setup");

ok("a labelled modal dialog", /<div class="sheet" id="wizard" hidden>\s*<div class="card" role="dialog" aria-modal="true" aria-labelledby="wiz-title">/.test(html));
ok("asks what the user already has, including the three subscriptions and Ollama",
   ["ollama", "chatgpt", "gemini", "copilot", "none"].every(k => new RegExp('\\["' + k + '",').test(W)));
ok("tick boxes in a fieldset with a legend; the route as radios in a fieldset",
   /<fieldset><legend><b>What do you already have\?<\/b>/.test(W) && /<fieldset><legend><b>Where should your ideas go\?<\/b>/.test(W) && /type="radio" name="wiz-route"/.test(W));
ok("the step number is in text, not only in dots", /st\.textContent = "Step " \+ WIZ\.step \+ " of " \+ last;/.test(W));
// honesty: no promise that a consumer subscription works
ok("ChatGPT: only approved apps may use a plan; Stagecraft is not one yet", /OpenAI lets only approved apps use a ChatGPT plan, and Stagecraft is not one of them yet/.test(W));
ok("Gemini: the subscription does not cover other apps; a free AI Studio key does", /the subscription does not cover other apps\. A free Gemini key from Google AI Studio does/.test(W));
ok("Copilot: not supported yet", /GitHub Copilot: not supported yet/.test(W));
ok("never says a subscription will be used", !/will use your (ChatGPT|Gemini|Copilot)|uses your (ChatGPT|Gemini|Copilot) (plan|subscription)/i.test(W));
ok("no copy says the cloud is needed (R-83)", !/\bneeds? (a |the )?(free )?cloud|cloud is required|requires? (a |the )?cloud/i.test(W));
// route: three choices, the measured evidence beside the accurate one, the default unchanged
ok("three routes: most accurate, this computer first, only this computer", /\["best", "Most accurate/.test(W) && /\["gaps", "This computer first/.test(W) && /\["local", "Only this computer"/.test(W));
ok("the accurate route cites the blind test", /scored 10\.5 to 11 out of 12 online, against 9 on this computer/.test(W));
ok("the preselected route is the app's current default (owner decision pending)", /const pick = WIZ\.route \|\| \(S\.cloudRoute === "best" \? "best" : "gaps"\);/.test(W));
// finishing
ok("finishing records the answers and never repeats the guide", /S\.setup = \{ done: true, at: Date\.now\(\), skipped: !!skipped, have: \[\.\.\.WIZ\.have\], route \};/.test(W));
ok("online routes go through the desktop's own opt-in dialog (R-84)", /await cloudToggle\(true\);/.test(W));
ok("Skip and Escape both skip for now", /data-wiz="skip">Skip for now/.test(W) && /e\.key === "Escape" && !\$\("wizard"\)\.hidden\)\{ e\.preventDefault\(\); wizFinish\(true\);/.test(html));
ok("the page behind is inert while it is open", /BEHIND_SHEET\(\)\.forEach\(el => \{ el\.inert = true;/.test(W));
ok("shown on first launch only (desktop and browser), never in a self-test",
   /if \(!\(S\.setup && S\.setup\.done\) && !_desk\.selftest\) openWizard\(\);/.test(html) && /if \(!\(S\.setup && S\.setup\.done\)\) openWizard\(\); else if \(!Object\.keys\(S\.keys\)\.length\) window\.openSheet\(\);/.test(html));
ok("the Providers sheet can open it again", /<button class="btn ghost" data-action="open-wizard">Set-up guide<\/button>/.test(html) && /act === "open-wizard"\) openWizard\(\);/.test(html));
ok("no inline handlers (R-41)", !/ on[a-z]+="/.test(W));

console.log(fail ? `setup-guide.test.js: ${pass} passed, ${fail} FAILED` : `setup-guide.test.js: ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
