#!/usr/bin/env node
// 2026-08-21 HIGH, found by adversarial review of that day's own changes: every chat() parsed
// the body BEFORE checking the status, so a 429 whose body is not JSON (an edge HTML page, an
// empty body) made `await r.json()` throw a plain SyntaxError. That error carries no
// .delivered, so neither exhaust() nor spend() ran: the spent provider kept full headroom and,
// because headroom is the sort key, sorted FIRST for every later stage — while the user was
// told "nothing was counted against your allowance", which was false.
//   Run:  node tests/ledger-blindness.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const a = html.indexOf("async function readBody(r){"), b = html.indexOf("/* ---------- quota ledger");
const SRC = html.slice(a, b);
const M = new Function(SRC + "\nreturn { readBody, httpFail };")();

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

(async () => {
  // an HTML error page must not hide the status
  const htmlBody = { text: async () => "<html><body>429 Too Many Requests</body></html>", status: 429, ok: false };
  const d1 = await M.readBody(htmlBody);
  ok("a non-JSON body still returns something", d1 && typeof d1 === "object");
  const e1 = M.httpFail(htmlBody, d1?.error?.message || d1?.__raw);
  ok("and the error is marked delivered", e1.delivered === true);
  ok("the status survives", e1.status === 429);
  ok("the raw body reaches the message", /Too Many Requests/.test(e1.message), e1.message);

  // an empty body must behave the same
  const empty = { text: async () => "", status: 502, ok: false };
  const e2 = M.httpFail(empty, (await M.readBody(empty))?.__raw);
  ok("an empty error body is still delivered", e2.delivered === true);
  ok("its status survives too", e2.status === 502);

  // a normal JSON body is unaffected
  const good = { text: async () => JSON.stringify({ choices: [{ message: { content: "hi" } }] }), status: 200, ok: true };
  const d3 = await M.readBody(good);
  ok("valid JSON parses as before", d3.choices[0].message.content === "hi");

  // and the regression itself: no chat() may parse the body before checking status
  const bad = (html.match(/const d = await r\.json\(\);\s*\n\s*if \(!r\.ok\)/g) || []).length;
  ok("no chat() parses the body before the status check", bad === 0, bad);
  // Derived from the number of chat implementations, not hardcoded: the point is that
  // EVERY provider reads its body this way, and a literal count silently stops checking
  // that the moment a provider is added (it did, when the litellm gateway landed).
  const chatCount = (html.match(/async chat\(/g) || []).length;
  const readCount = (html.match(/const d = await readBody\(r\);/g) || []).length;
  ok("every chat body uses readBody", readCount === chatCount, readCount + " of " + chatCount);

  console.log(pass + "/" + (pass + fail) + " pass");
  process.exit(fail ? 1 : 0);
})();
