#!/usr/bin/env node
// 2026-08-21: Consolidate never completed in either run. Browser fetch has no default timeout,
// so in the page a slow last stage hangs on "Working…" forever rather than failing. Stage
// latency grows with carried context (43s, 62s, 107s, 147s, 209s on a local 3B), so the LAST
// stage is the one that needs a deadline most.
//   Run:  node tests/timeout.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const a = html.indexOf("const DEFAULT_TIMEOUT_MS"), b = html.indexOf("function httpFail");
const SRC = html.slice(a, b);

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

(async () => {
  // a fetch that never resolves must still reject, and quickly, once the deadline passes
  const hang = () => new Promise(() => {});
  let T = new Function("fetch", "AbortController", "setTimeout", "clearTimeout",
    SRC + "\nreturn { fetchWithTimeout, timeoutFail, DEFAULT_TIMEOUT_MS };")(
      (url, opts) => opts.signal.aborted ? Promise.reject(Object.assign(new Error("aborted"), {name:"AbortError"}))
        : new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), {name:"AbortError"})))),
      AbortController, setTimeout, clearTimeout);

  let err = null;
  try { await T.fetchWithTimeout("http://x", {}, 2000); } catch (e){ err = e; }
  ok("a hanging request rejects instead of hanging", !!err);
  ok("it is reported as a timeout", err && err.timedOut === true);
  ok("it counts against the allowance", err && err.delivered === true, err && err.delivered);
  ok("the message names the deadline", err && /2s/.test(err.message), err && err.message);

  // a normal response is untouched by the wrapper
  const T2 = new Function("fetch", "AbortController", "setTimeout", "clearTimeout",
    SRC + "\nreturn { fetchWithTimeout };")(
      async () => ({ ok: true, marker: "real response" }), AbortController, setTimeout, clearTimeout);
  const r = await T2.fetchWithTimeout("http://x", {}, 5000);
  ok("a fast response passes straight through", r && r.marker === "real response");

  ok("a default deadline exists", typeof T.DEFAULT_TIMEOUT_MS === "number" && T.DEFAULT_TIMEOUT_MS > 0);
  ok("the local provider gets a longer one than the default",
     /timeoutMs:\s*600000/.test(html) && T.DEFAULT_TIMEOUT_MS < 600000);
  const chatCount = (html.match(/async chat\(/g) || []).length;
  const dlCount   = (html.match(/\}, this\.timeoutMs\);/g) || []).length;
  // Derived, not hardcoded — see the note in ledger-blindness.test.js.
  // DESIGN-desktop R-12 amendment (step 6): local chat streams and is held to first-line,
  // inactivity and hard-cap deadlines (R-63) instead of one total, so it is the one chat that
  // does not end in `}, this.timeoutMs);`. Every other chat still must.
  ok("every non-local chat call carries a deadline", dlCount === chatCount - 1, dlCount + " of " + (chatCount - 1));
  const li = html.indexOf("  local: {"), lj = html.indexOf("  openrouter: {");
  const localChat = html.slice(html.indexOf("async chat(", li), lj);
  ok("local chat carries an inactivity deadline", /idleMs/.test(localChat));

  console.log(pass + "/" + (pass + fail) + " pass");
  process.exit(fail ? 1 : 0);
})();
