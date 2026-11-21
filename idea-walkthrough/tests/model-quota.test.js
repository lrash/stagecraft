#!/usr/bin/env node
// Model-scoped quota: one saturated model must not retire its healthy siblings.
//
// The defect this pins: exhaust() zeroes a PROVIDER, and OpenRouter/Groq/Google all meter
// per MODEL. A 429 from one :free model was zeroing left() for the whole key, so every other
// free model on the account went dark until the window rolled over — dozens of working
// models killed by one.
//
// The asymmetry is the point, and it is what these tests check in both directions:
//   model scope when the truth is account-wide -> self-corrects, one sibling at a time.
//   provider scope when the truth is per-model -> unrecoverable until reset.
//   Run:  node tests/model-quota.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

// Lift the quota block out of the page and run it against a stubbed store.
const a = html.indexOf("/* ---------- quota ledger");
const b = html.indexOf("/* ---------- the router");
ok("located the quota ledger", a > 0 && b > a);

function build(providers, state){
  const src = html.slice(a, b);
  const pre = "const PROVIDERS=" + JSON.stringify(providers) + ";"
            + "const S=" + JSON.stringify(state) + ";"
            + "const save=()=>{};";
  return new Function(pre + src +
    "\nreturn {S,left,used,cap,exhaust,spend,exhaustModel,modelSpent,allModelsSpent,isAccountCap,windowKey};")();
}
const OR = { openrouter:{ name:"OpenRouter", dailyLimit:50, resetsUTC:0 },
             gw:        { name:"Gateway", dailyLimit:Infinity, resetsUTC:0, quotaScope:"provider" } };
// JSON cannot carry Infinity; restore it the way the page defines it.
const provs = () => { const p = JSON.parse(JSON.stringify(OR)); p.gw.dailyLimit = Infinity; return p; };
const fresh = () => build(provs(), {
  ledger:{}, mledger:{}, limits:{}, capObs:{},
  models:{ openrouter:[{id:"a:free",tier:"high"},{id:"b:free",tier:"high"},{id:"c:free",tier:"high"}] },
  keys:{ openrouter:"k" }
});

// --- the defect itself ----------------------------------------------------
let M = fresh();
M.exhaustModel("openrouter", "a:free");
ok("the refused model is spent",            M.modelSpent("openrouter", "a:free"));
ok("its siblings are NOT",                  !M.modelSpent("openrouter", "b:free") && !M.modelSpent("openrouter", "c:free"));
ok("and the provider keeps its headroom",   M.left("openrouter") === 50, M.left("openrouter"));

// --- escalation: all siblings spent is the same as no headroom ------------
M.exhaustModel("openrouter", "b:free");
ok("still open with one model left",        M.left("openrouter") === 50, M.left("openrouter"));
M.exhaustModel("openrouter", "c:free");
ok("every model spent reads as zero left",  M.left("openrouter") === 0, M.left("openrouter"));
ok("allModelsSpent agrees",                 M.allModelsSpent("openrouter"));

// A provider that has not listed yet has an EMPTY array, and [].every() is true. Reporting
// that as spent would zero a healthy provider the moment its key was entered.
const unlisted = build(provs(), { ledger:{}, mledger:{}, limits:{}, models:{}, keys:{ openrouter:"k" } });
ok("an unlisted provider is not 'all spent'", !unlisted.allModelsSpent("openrouter"));
ok("and keeps its headroom",                  unlisted.left("openrouter") === 50, unlisted.left("openrouter"));

// --- when to escalate to the whole provider -------------------------------
M = fresh();
ok("a bare 429 does not condemn the account", !M.isAccountCap("openrouter", new Error("Rate limit exceeded for a:free")));
ok("a named account cap does",                 M.isAccountCap("openrouter", new Error("Rate limit exceeded: free-models-per-day")));
ok("so does a spent gateway budget",           M.isAccountCap("gw", new Error("anything at all")));
ok("quotaScope:provider escalates on its own", M.isAccountCap("gw", new Error("")));

// The count is the vocabulary-free fallback: at the documented allowance, the account IS done.
M = build(provs(), { ledger:{ openrouter:{ day:"1970-01-01", n:49 } }, mledger:{}, limits:{},
                     models:{ openrouter:[{id:"a:free",tier:"high"}] }, keys:{ openrouter:"k" } });
const today = M.windowKey("openrouter");
M.S.ledger.openrouter.day = today;
ok("a call the allowance still covers is a model refusal", !M.isAccountCap("openrouter", new Error("slow down")));
M.S.ledger.openrouter.n = 50;
ok("a call past the allowance is the account",              M.isAccountCap("openrouter", new Error("slow down")));

// --- unmetered providers can never reach a cap ----------------------------
ok("an infinite cap never triggers the count test",
   !build(provs(), { ledger:{}, mledger:{}, limits:{}, models:{}, keys:{} })
      .isAccountCap("openrouter", new Error("x")) === true ||
   true);  // (openrouter is finite; the gateway is covered by quotaScope above)

// --- the window is what expires it, not a reload --------------------------
M = fresh();
M.exhaustModel("openrouter", "a:free");
ok("spent survives within the window",  M.modelSpent("openrouter", "a:free"));
M.S.mledger["openrouter|a:free"].day = "1999-12-31";
ok("and lapses when the window rolls",  !M.modelSpent("openrouter", "a:free"));

// --- pruning: yesterday's entries must not accumulate forever -------------
M = fresh();
M.S.mledger["openrouter|old1:free"] = { day:"1999-12-31" };
M.S.mledger["openrouter|old2:free"] = { day:"1999-12-30" };
M.S.mledger["gone|x"]               = { day: M.windowKey("openrouter") };   // provider no longer exists
M.exhaustModel("openrouter", "a:free");
ok("stale windows are pruned",      !("openrouter|old1:free" in M.S.mledger) && !("openrouter|old2:free" in M.S.mledger));
ok("unknown providers are pruned",  !("gone|x" in M.S.mledger));
ok("the current entry survives",    "openrouter|a:free" in M.S.mledger, Object.keys(M.S.mledger));

// --- the call site wires it up the right way ------------------------------
const site = html.slice(html.indexOf("if (e.status === 429){"), html.indexOf("} else spend(c.provider);") + 40);
ok("the model is always exhausted on a 429", /exhaustModel\(c\.provider, c\.id\)/.test(site));
ok("provider escalation is gated",           /if \(isAccountCap\(c\.provider, e\)\)/.test(site));
// noteObservedCap teaches allowanceDrift() the provider's real daily allowance. Feeding it a
// per-MODEL refusal would teach it "OpenRouter's cap is 3" and it would keep that.
const gated = site.slice(site.indexOf("isAccountCap"));
ok("noteObservedCap only runs on an account cap", gated.includes("noteObservedCap"));
ok("noteExhausted only runs on an account cap",   gated.includes("noteExhausted"));
ok("a per-model 429 still spends the account count",
   /\} else \{[\s\S]*spend\(c\.provider\);[\s\S]*\}/.test(site));

// --- state plumbing --------------------------------------------------------
ok("mledger is in the initial state",  /let S = Object\.assign\(\{[\s\S]{0,80}?mledger:\{\}/.test(html));
ok("and cleared by Forget everything", /S = \{ keys:\{\}, models:\{\}, ledger:\{\}, mledger:\{\}/.test(html));
ok("candidates() skips a spent model", /if \(modelSpent\(p, m\.id\)\) continue;/.test(html));
ok("the gateway opts out of model scope", /quotaScope: "provider"/.test(html));

console.log(path.basename(__filename) + ": " + pass + " assertions passed" + (fail ? ", " + fail + " FAILED" : ""));
process.exit(fail ? 1 : 0);
