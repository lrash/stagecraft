// The routing log: why a stage changed model.
//
// 2026-08-22: a run showed "after 1 failed attempt" on four stages and a reviewer read it
// as a chronically bad first choice. It was four models hitting their daily caps — the
// system doing exactly what it is for. A count without a cause invites that misreading,
// and automating the hand-off needs the cause anyway: you cannot move on from a model
// automatically until you can say why you are moving.
const assert = require("assert");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");

const i = html.indexOf("function classifyAttempt(e){");
assert.ok(i > -1, "classifyAttempt not found");
const classifyAttempt = new Function(
  html.slice(i, html.indexOf("\n}", i) + 2) + "\nreturn classifyAttempt;")();

let n = 0, bad = 0;
const ok = (m, c, extra) => { if (c) n++; else { bad++; console.log("FAIL  " + m + (extra ? "  [" + JSON.stringify(extra) + "]" : "")); } };

const httpFail = (status) => { const e = new Error("x"); e.delivered = true; e.status = status; return e; };
const truncFail = () => { const e = new Error("cut off"); e.delivered = true; e.truncated = true; return e; };
const timeoutFail = () => { const e = new Error("timed out"); e.timedOut = true; e.delivered = true; return e; };

// --- the distinction the whole log exists to make ----------------------------
const cap = classifyAttempt(httpFail(429));
ok("a 429 is quota-exhausted", cap.reason === "quota-exhausted", cap);
ok("a daily cap is EXPECTED, not a fault", cap.expected === true, cap);

[ [httpFail(401), "auth-rejected"],
  [httpFail(403), "auth-rejected"],
  [httpFail(500), "http-500"],
  [truncFail(),   "truncated"],
  [timeoutFail(), "timeout"],
  [new TypeError("Failed to fetch"), "unreachable"],
].forEach(([e, want]) => {
  const c = classifyAttempt(e);
  ok(want + " is classified", c.reason === want, c);
  ok(want + " is NOT expected", c.expected === false, c);
});

// --- success ------------------------------------------------------------------
const good = classifyAttempt(null);
ok("no error means ok", good.outcome === "ok" && good.expected === true, good);

// --- ordering traps -----------------------------------------------------------
// A timeout and a truncation are both `delivered`, and a 429 is delivered too. If status
// were checked first, a truncated 200 or a timeout would be misfiled as an http error.
const truncWithStatus = truncFail(); truncWithStatus.status = 200;
ok("truncation beats status", classifyAttempt(truncWithStatus).reason === "truncated");
const toWithStatus = timeoutFail(); toWithStatus.status = 504;
ok("timeout beats status", classifyAttempt(toWithStatus).reason === "timeout");

// --- the export must carry it, and must say a cap is not an error --------------
ok("export writes a Routing log section", /## Routing log/.test(html));
ok("export explains that a cap is not an error", /It is not an error/.test(html));
ok("export flags failures a cap does not explain", /NOT explained by a daily cap/.test(html));
ok("log is capped so localStorage cannot grow without bound", /DEBUG_MAX/.test(html));
ok("a phone with no console can still get it (export)", /S\.debug/.test(html));

// --- 2026-11-17: the footer says what happened; a replaced answer is marked ---------------
{
  const a = html.indexOf("function routingFooter(dbg){"), b = html.indexOf("const DEAD = new Set();");
  ok("routing footer helpers found", a > -1 && b > a);
  const R = new Function(html.slice(a, b) + "\nreturn { routingFooter, replacedRows };")();
  const okRow = (stage) => ({ stage, outcome: "ok", expected: true });
  ok("no hand-offs is said plainly", /^No hand-offs/.test(R.routingFooter([okRow("capture"), okRow("diverge")])));
  ok("an empty log is not called a daily cap", !/daily cap/.test(R.routingFooter([])));
  ok("cap-only hand-offs keep their sentence",
     /Every hand-off was a daily cap/.test(R.routingFooter([{ stage:"deepen", outcome:"fail", expected:true }, okRow("deepen")])));
  ok("an unexpected failure is still flagged",
     /NOT explained by a daily cap: template-echo/.test(R.routingFooter([{ stage:"critique", outcome:"fail", expected:false, reason:"template-echo" }])));
  const rep = R.replacedRows([okRow("capture"), okRow("critique"), okRow("critique"), okRow("reconcile")]);
  ok("a re-run stage's earlier answer is marked replaced", rep.has(1) && rep.size === 1, [...rep]);
  ok("the export writes it", /replaced\.has\(i\) \? "replaced by a later run"/.test(html));
}
console.log((bad ? "FAILED " : "") + n + " assertions passed" + (bad ? ", " + bad + " failed" : ""));
process.exit(bad ? 1 : 0);
