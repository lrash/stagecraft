#!/usr/bin/env node
// DESIGN-desktop step 1 (A-2): the browser-visible groundwork for the desktop build.
//  - no inline on*="" handlers (R-41): the desktop CSP refuses inline script, so every action
//    goes through one delegated listener keyed on data-action;
//  - Ollama is addressed as 127.0.0.1, never "localhost" (D-8: localhost may resolve to ::1);
//  - the roster call has a deadline (R-35) and keeps size/params (R-50, R-65).
//   Run:  node tests/desktop-inline.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

ok("no inline on*= handler attributes remain", (html.match(/ on[a-z]+="/g) || []).length === 0,
   html.match(/ on[a-z]+="[^"]*"/g));
for (const a of ["open-sheet", "clear-notices", "stop-auto-lower"])
  ok("the markup names the " + a + " action", html.includes('data-action="' + a + '"'));
ok("one delegated listener decides what an action does",
   /document\.addEventListener\("click", e => \{\s*const t = e\.target && e\.target\.closest \? e\.target\.closest\("\[data-action\]"\)/.test(html));

// The delegated listener itself, run against a fake document.
{
  const i = html.indexOf('document.addEventListener("click", e => {\n  const t = e.target');
  const j = html.indexOf("\n});", i) + 4;
  const src = html.slice(i, j);
  let handler = null; const calls = [];
  const document = { addEventListener: (ev, fn) => { if (ev === "click") handler = fn; } };
  const window = { openSheet: () => calls.push("sheet"), stopAutoLower: () => calls.push("stop") };
  const notices = { innerHTML: "x" };
  new Function("document", "window", "$", src)(document, window, id => id === "notices" ? notices : null);
  const el = act => ({ closest: () => ({ getAttribute: () => act }) });
  handler({ target: el("open-sheet") });
  handler({ target: el("stop-auto-lower") });
  handler({ target: el("clear-notices") });
  handler({ target: { closest: () => null } });
  ok("open-sheet opens the sheet, stop-auto-lower stops it", calls.join(",") === "sheet,stop", calls);
  ok("clear-notices clears the notices", notices.innerHTML === "", notices.innerHTML);
}

// PROVIDERS.local, lifted and run with a mocked fetchWithTimeout.
const a = html.indexOf("  local: {"), b = html.indexOf("  openrouter: {");
const localSrc = html.slice(a, b);
ok("local base is 127.0.0.1, not localhost", /base: "http:\/\/127\.0\.0\.1:11434"/.test(localSrc));

const ca = html.indexOf("function classify(id){"), cb = html.indexOf("/* Not every model in a free catalogue");
const NC = html.slice(html.indexOf("const NOT_CHAT"), html.indexOf("/* ---------- providers"));
(async () => {
  const seen = [];
  const fwt = async (url, opts, ms) => { seen.push({ url, ms }); return {
    ok: true, json: async () => ({ models: [
      { name: "qwen3:8b", size: 5225388164, details: { parameter_size: "8.2B" } },
      { name: "gemma3:270m", size: 291554930, details: { parameter_size: "270M" } },
      { name: "nomic-embed-text:latest", size: 274302450, details: { parameter_size: "137M" } },
    ] }) }; };
  const local = new Function("fetchWithTimeout", html.slice(ca, cb) + NC + "\nreturn {" + localSrc + "}.local;")(fwt);
  const ms = await local.list();
  ok("the roster call carries an 8 s deadline", seen.length === 1 && seen[0].ms === 8000, seen);
  ok("the roster call goes to 127.0.0.1/api/tags", seen[0] && seen[0].url === "http://127.0.0.1:11434/api/tags", seen);
  ok("embedding models are still filtered out", ms.length === 2 && !ms.some(m => /embed/.test(m.id)), ms);
  ok("size is kept on each model", ms[0].size === 5225388164, ms[0]);
  ok("params is the parsed parameter_size in billions", ms[0].params === 8.2 && Math.abs(ms[1].params - 0.27) < 1e-9, ms);
  ok("tier is unchanged by the extra fields", ms[0].tier === "low" && ms[1].tier === "low", ms);

  console.log(fail ? `desktop-inline.test.js: ${pass} passed, ${fail} FAILED`
                   : `desktop-inline.test.js: ${pass} assertions passed`);
  process.exit(fail ? 1 : 0);
})();
