#!/usr/bin/env node
// Regression tests for Stagecraft's router and quota ledger.
// Every one of these covers a defect found in the 2026-08-20 review; the code under test
// is lifted straight out of index.html so the test cannot drift from the shipped page.
//   Run:  node tests/router.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// Pull the three source blocks the router needs, by their own section markers.
function slice(from, to){
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  if (a < 0 || b < 0) { console.error("could not locate " + JSON.stringify(from)); process.exit(1); }
  return html.slice(a, b);
}
const SRC =
  slice('const TIERS = ["low","medium","high"];', "\n\n// Heuristic:") +
  slice("function windowKey(p, now){", "/* ---------- the router") +
  slice("const DEAD = new Set();", "/* ---------- the six stages");

// S, PROVIDERS and save() are the page's globals; supply them as parameters so the extracted
// source runs unmodified.
const build = new Function("S", "PROVIDERS", "save", SRC +
  "\nreturn { candidates, pick, cap, left, used, spend, setReportedLimit, windowKey, resetsIn, exhaust, DEAD, markDead, SORT_ROOM_CAP };");

const PROVIDERS = {
  local:      { name:"On this computer", keyless:true, dailyLimit:Infinity, resetsUTC:0 },
  openrouter: { name:"OpenRouter",       dailyLimit:50,  resetsUTC:0 },
  groq:       { name:"Groq",             dailyLimit:200, resetsUTC:0 },
};
function fresh(models){
  const S = { keys:{}, models:{}, ledger:{}, limits:{} };
  for (const p of Object.keys(models)){ S.keys[p] = "k"; S.models[p] = models[p]; }
  const R = build(S, PROVIDERS, () => {});
  R.DEAD.clear();
  return { S, R };
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => cond
  ? pass++
  : (fail++, console.log("FAIL  " + name + (detail ? "\n      " + detail : "")));

/* --- HIGH: a stale local roster must not be able to win a tier it does not clear ------
   classifyLocal now reads deepseek-r1:latest as its real 8B, i.e. low. Even with infinite
   headroom it must be invisible to the High floor rather than sorting first. */
{
  const { R } = fresh({
    local:      [{ id:"deepseek-r1:latest", tier:"low" }],
    openrouter: [{ id:"meta-llama/llama-3.3-70b-instruct:free", tier:"high" }],
  });
  const got = R.pick("high");
  ok("local low-tier model cannot serve a high floor",
     got.ok && got.choice.provider === "openrouter",
     "picked " + JSON.stringify(got.choice || got));
  ok("local model is absent from the high-floor candidate list",
     R.candidates("high").every(c => c.provider !== "local"));
}

/* --- HIGH: an infinite quota must not act as an infinite quality score ---------------
   Provider preference is now an explicit term applied after tier, and sortRoom is clamped,
   so the comparator can never see Infinity (or produce Infinity-Infinity = NaN). */
{
  const { R } = fresh({
    local:      [{ id:"llama3.1:8b", tier:"low" }],
    openrouter: [{ id:"cloud-low", tier:"low" }],
  });
  const c = R.candidates("low");
  ok("sort headroom is clamped, never Infinity",
     c.every(x => Number.isFinite(x.sortRoom) && x.sortRoom <= R.SORT_ROOM_CAP),
     JSON.stringify(c.map(x => x.sortRoom)));
  /* Checked on a LOCAL-ONLY roster: local is no longer offered on the low floor when a cloud
     model exists, so this can no longer be asserted from `c` above. The property under test
     is unchanged — headroom is reported unclamped even when sortRoom is capped. */
  {
    const { R: Ronly } = fresh({ local: [{ id:"llama3.1:8b", tier:"low" }] });
    const only = Ronly.candidates("low");
    ok("true headroom is still reported unclamped for display",
       only.find(x => x.provider === "local").headroom === Infinity);
    ok("...while its sort headroom stays clamped",
       Number.isFinite(only[0].sortRoom) && only[0].sortRoom <= Ronly.SORT_ROOM_CAP,
       only[0].sortRoom);
  }
  /* 2026-08-23: this used to assert local sorts FIRST here. On the LOW floor local is now
     dropped from the pool entirely when an online model exists — a 0.6b local model took 442s
     on Diverge and returned no divergence at all. The original point still stands and is what
     is asserted below: ordering comes from explicit terms, never from Infinity headroom
     leaking in as a quality score. */
  ok("local is not offered on the low floor when a cloud model exists",
     c.every(x => x.provider !== "local"),
     JSON.stringify(c.map(x => x.provider + ":" + x.pref)));
  ok("the online model takes the floor",
     c[0].provider === "openrouter" && c[0].pref === 1,
     JSON.stringify(c.map(x => x.provider + ":" + x.pref)));
}

/* --- LOW: with no cloud provider at all, local must still serve the floor -------------- */
{
  const { R } = fresh({ local: [{ id:"llama3.1:8b", tier:"low" }] });
  ok("local still serves the low floor when it is the only provider",
     R.candidates("low")[0]?.provider === "local");
}

/* --- the drop is scoped to the low floor only ----------------------------------------- */
{
  const { R } = fresh({
    local:      [{ id:"llama3.1:8b", tier:"medium" }],
    openrouter: [{ id:"cloud-med",   tier:"medium" }],
  });
  const c = R.candidates("medium");
  ok("off the low floor, keyless is still preferred first",
     c[0].provider === "local" && c[0].pref === 0,
     JSON.stringify(c.map(x => x.provider + ":" + x.pref)));
}

/* --- HIGH: a candidate that errored is set aside, so the router stops re-choosing it --- */
{
  const { R } = fresh({
    local:      [{ id:"llama3.1:8b", tier:"low" }],
    openrouter: [{ id:"cloud-low", tier:"low" }],
  });
  const first = R.pick("low").choice;
  R.markDead(first);
  const second = R.pick("low");
  ok("a dead candidate is dropped from the candidate list",
     R.candidates("low").every(c => !(c.provider === first.provider && c.id === first.id)));
  ok("the router fails over to the next candidate",
     second.ok && second.choice.id !== first.id, JSON.stringify(second));
  R.markDead(second.choice);
  ok("with every candidate dead the router says so rather than substituting",
     R.pick("low").ok === false);
}

/* --- HIGH: a provider-reported allowance must expire, and must not be subtracted twice --- */
{
  const { S, R } = fresh({ openrouter: [{ id:"cloud-low", tier:"low" }] });
  R.spend("openrouter"); R.spend("openrouter");            // used = 2
  R.setReportedLimit("openrouter", { dailyRemaining: 40 });
  ok("a reported remainder is stored as a cap, so left() equals the remainder",
     R.left("openrouter") === 40, "left=" + R.left("openrouter") + " cap=" + R.cap("openrouter"));

  S.limits.openrouter = { day: "1999-01-01", cap: 4 };
  ok("a reading from an earlier window is ignored, not carried over",
     R.cap("openrouter") === 50, "cap=" + R.cap("openrouter"));

  S.limits.openrouter = 4;                                  // the shape the old code wrote
  ok("a bare number (the pre-fix format) is ignored in favour of the constant",
     R.cap("openrouter") === 50, "cap=" + R.cap("openrouter"));

  S.limits.openrouter = { day: R.windowKey("openrouter"), cap: 12 };
  R.setReportedLimit("openrouter", null);
  ok("a provider that reports nothing clears the stored value instead of keeping it",
     S.limits.openrouter === undefined && R.cap("openrouter") === 50);
}

/* --- the tier floor itself: cheapest adequate tier, never a silent downgrade ---------- */
{
  const { R } = fresh({ openrouter: [
    { id:"a-low", tier:"low" }, { id:"b-medium", tier:"medium" }, { id:"c-high", tier:"high" },
  ]});
  ok("a low stage takes the low model", R.pick("low").choice.id === "a-low");
  ok("a medium stage skips the low model", R.pick("medium").choice.id === "b-medium");
  ok("a high stage takes the high model", R.pick("high").choice.id === "c-high");
}

// 2026-08-20 MEDIUM: Gemini's reset was pinned to a fixed UTC hour, so for the ~4 months of
// PST the ledger freed the allowance an hour before Google did — the gauge read full while
// every call still counted against the day the user had already spent.
{
  const P = { gemini: { resetsTZ:"America/Los_Angeles", resetsUTC:8, dailyLimit:50 } };
  const R = build({ keys:{}, models:{}, ledger:{}, limits:{} }, P, () => {});
  const pst = Date.parse("2026-01-15T07:30:00Z");  // 23:30 Pacific Jan 14 — still Google's Jan 14
  const pdt = Date.parse("2026-07-15T07:30:00Z");  // 00:30 Pacific Jul 15 — genuinely a new day
  ok("PST: the window has NOT rolled over yet", R.windowKey("gemini", pst) === "2026-01-14");
  ok("PST: reset is minutes away, not a day",   R.resetsIn("gemini", pst) === "30m");
  ok("PDT: the window HAS rolled over",         R.windowKey("gemini", pdt) === "2026-07-15");
  ok("PDT: a full day is advised correctly",    R.resetsIn("gemini", pdt) === "23h 30m");
}

// 2026-08-20 MEDIUM: an HTTP error skipped spend() entirely, so a provider that had just
// 429'd still reported full headroom — and headroom is the sort key, so the dead provider was
// re-picked first for every later stage.
{
  const { R } = fresh({ openrouter:[{ id:"m", tier:"low" }] });
  ok("starts with the full allowance", R.left("openrouter") === 50);
  R.exhaust("openrouter");
  ok("a 429 zeroes the window, not one call", R.left("openrouter") === 0);
  ok("and it does not go negative",           R.left("openrouter") >= 0);
}

console.log(pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);
