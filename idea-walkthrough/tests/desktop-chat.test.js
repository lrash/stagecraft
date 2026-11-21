#!/usr/bin/env node
// DESIGN-desktop steps 6 and 10: local chat streams (R-62), is held to three deadlines (R-63),
// fixes num_ctx per model (R-60) and reports a full context (R-61). The provider and its helpers
// are lifted from index.html and run against a mocked Ollama stream.
//   A-9  a stall before the first line uses firstLineMs; a stall after it, idleMs; Stop -> stopped
//   A-22 ctxMax 40960 -> 16384; ctxMax 4096 -> 4096 and a 14.2k-char prompt refused; show fails -> 8192
//   A-23 prompt_eval_count = num_ctx, and prompt+eval >= num_ctx-64 -> context-full, not retried
//   Run:  node tests/desktop-chat.test.js
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };

const SRC = cut("function classify(id){", "/* ---------- providers")
  + "const PROVIDERS = {\n" + cut("  local: {", "  openrouter: {") + "};\n"
  + cut("/* ---------- local model facts", "/* A response that came back")
  + cut("const DEFAULT_TIMEOUT_MS", "/* ---------- quota ledger")
  + cut("function classifyAttempt(e){", "function logAttempt(")
  + cut("const RETIRE = {", "/* ---------- learning when");

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));

const SCALE = 1000;   // every timer runs 1000x faster, so a 120 s deadline takes 120 ms
const enc = new TextEncoder();

/* A mocked Ollama. `show` answers /api/show; `script` is a list of [delayMs, line] for /api/chat,
   and `hang: true` leaves the stream open after the last line. Aborts behave like plugin-http:
   the pending read rejects with the bare string "Request cancelled". */
function harness({ show = { ok: true, ctx: 40960 }, script = [], hang = false, S = {} } = {}){
  const seen = { chat: [], show: 0, armed: [] };
  const fetch = async (url, init = {}) => {
    if (/\/api\/show$/.test(url)){
      seen.show++;
      if (!show.ok) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => ({ model_info: {
        "general.architecture": "qwen3", "qwen3.context_length": show.ctx, "qwen3.block_count": 36,
        "qwen3.attention.head_count_kv": 8, "qwen3.attention.key_length": 128, "qwen3.attention.value_length": 128 } }) };
    }
    seen.chat.push(JSON.parse(init.body));
    const sig = init.signal;
    let i = 0;
    return { ok: true, status: 200, body: { getReader: () => ({
      read: () => new Promise((res, rej) => {
        const onAbort = () => rej("Request cancelled");
        if (sig.aborted) return onAbort();
        sig.addEventListener("abort", onAbort, { once: true });
        if (i >= script.length){ if (!hang) res({ done: true }); return; }
        const [ms, line] = script[i++];
        setTimeout(() => { sig.removeEventListener("abort", onAbort); res({ done: false, value: enc.encode(line + "\n") }); }, ms);
      })
    }) } };
  };
  const fast = (fn, ms) => { seen.armed.push(ms); return setTimeout(fn, ms / SCALE); };
  const LOCAL = { show: {} };
  const M = new Function("fetch", "S", "LOCAL", "setTimeout", "clearTimeout", SRC +
    "\nreturn { local: PROVIDERS.local, classifyAttempt, retireScope, localNumCtx, kvBytes, localShow, REPLY_RESERVE };")(
    fetch, S, LOCAL, fast, clearTimeout);
  return { M, seen, S, LOCAL };
}
const line = o => JSON.stringify(o);
const tok = (t, think) => line({ message: think ? { content: "", thinking: t } : { content: t }, done: false });
const done = (pe, ev, extra) => line(Object.assign({ message: { content: "" }, done: true, done_reason: "stop",
  prompt_eval_count: pe, prompt_eval_duration: 2e9, eval_count: ev, eval_duration: 1e9 }, extra || {}));

(async () => {
  /* ---- a normal stream ---- */
  {
    const { M, seen, S } = harness({ script: [[5, tok("hmm", true)], [5, tok("O")], [5, tok("K")], [5, done(100, 30)]] });
    const prog = [], metrics = {};
    const out = await M.local.chat("local", "qwen3:8b", "Reply with OK", { onProgress: p => prog.push(p), metrics });
    ok("returns the streamed answer", out === "OK", out);
    ok("thinking is counted, never part of the answer", !/hmm/.test(out) && metrics.thinkingChunks === 1, metrics);
    ok("requests a stream", seen.chat[0].stream === true);
    ok("progress is reported more than once", prog.length >= 2, prog.length);
    ok("progress names the phase", prog[0].phase === "thinking" && prog.some(p => p.phase === "writing"), prog.map(p => p.phase));
    ok("metrics carry eval and prompt counts", metrics.evalCount === 30 && metrics.promptEvalCount === 100, metrics);
    ok("tok/s is eval_count / eval_duration", Math.abs(metrics.tokPerSec - 30) < 1e-9, metrics.tokPerSec);
    ok("first chunk comes before the total", metrics.firstChunkMs <= metrics.totalMs, metrics);
    ok("num_ctx is in the metrics", metrics.numCtx === 16384, metrics.numCtx);
    ok("the prefill rate is measured for next time", S.prefill && S.prefill["qwen3:8b"] === 50, S.prefill);
  }

  /* ---- A-22: num_ctx is fixed per model ---- */
  {
    const big = harness({ show: { ok: true, ctx: 40960 }, script: [[1, tok("a")], [1, done(10, 1)]] });
    await big.M.local.chat("local", "m", "x".repeat(100));
    const big2 = harness({ show: { ok: true, ctx: 40960 }, script: [[1, tok("a")], [1, done(10, 1)]] });
    await big2.M.local.chat("local", "m", "x".repeat(20000));
    ok("ctxMax 40960 -> num_ctx 16384, for a short prompt", big.seen.chat[0].options.num_ctx === 16384);
    ok("...and for a long one (fixed, never per stage)", big2.seen.chat[0].options.num_ctx === 16384);
    const small = harness({ show: { ok: true, ctx: 4096 } });
    ok("ctxMax 4096 -> 4096", (await small.M.localNumCtx("m")) === 4096);
    let e = null; try { await small.M.local.chat("local", "m", "x".repeat(14200)); } catch (x){ e = x; }
    ok("a 14.2k-char prompt is refused before sending", e && e.contextRefused && small.seen.chat.length === 0, e && e.message);
    ok("...saying the context is too long", e && /context is too long/i.test(e.message));
    ok("...classified context-too-long, ended without retry", small.M.classifyAttempt(e).reason === "context-too-long"
       && small.M.retireScope("context-too-long") === "none");
    const down = harness({ show: { ok: false } });
    ok("an /api/show failure -> 8192", (await down.M.localNumCtx("m")) === 8192);
    ok("...and the failure is not cached", (await down.M.localNumCtx("m")) === 8192 && down.seen.show === 2, down.seen.show);
    ok("KV size from the model's shape (qwen3:8b ~144 KB/token)", big.M.kvBytes({ blocks: 36, kvHeads: 8, keyLen: 128, valLen: 128 }, 1) === 147456);
    ok("KV falls back to 160 KB/token", big.M.kvBytes({}, 2) === 2 * 160 * 1024);
  }

  /* ---- A-23: context-full ---- */
  for (const [name, d] of [["prompt_eval_count = num_ctx", done(16384, 5)], ["prompt + eval >= num_ctx - 64", done(12000, 4330)]]){
    const { M } = harness({ script: [[1, tok("a")], [1, d]] });
    let e = null; try { await M.local.chat("local", "m", "hi"); } catch (x){ e = x; }
    ok("context-full: " + name, e && e.contextFull === true, e && e.message);
    const c = M.classifyAttempt(e);
    ok("...is classified context-full, not retried and not dead", c.reason === "context-full" && M.retireScope(c.reason) === "none", c);
    ok("...and says the model may not have seen the whole context", e && /may not have seen the whole context/.test(e.message));
  }
  {
    const { M } = harness({ script: [[1, tok("a")], [1, done(10, 2, { done_reason: "length" })]] });
    let e = null; try { await M.local.chat("local", "m", "hi"); } catch (x){ e = x; }
    ok("done_reason length is still a truncation", e && e.truncated === true);
  }
  {
    const { M } = harness({ script: [[1, line({ error: "model requires more system memory" })]] });
    let e = null; try { await M.local.chat("local", "m", "hi"); } catch (x){ e = x; }
    ok("an error line mid-stream is a delivered failure", e && e.delivered && /more system memory/.test(e.message), e && e.message);
  }

  /* ---- A-9: deadlines ---- */
  {
    const { M, seen } = harness({ script: [], hang: true });
    const t0 = Date.now(); let e = null;
    try { await M.local.chat("local", "m", "hi"); } catch (x){ e = x; }
    ok("a stall before the first line times out", e && e.timedOut === true, e && e.message);
    ok("...on firstLineMs, which is timeoutMs (600 s) with no measurement", seen.armed.includes(600000) && /600s/.test(e.message), seen.armed);
    ok("...quickly under the scaled clock", Date.now() - t0 < 3000);
  }
  {
    const { M, seen } = harness({ script: [], hang: true, S: { prefill: { m: 100 } } });
    let e = null; try { await M.local.chat("local", "m", "x".repeat(3000)); } catch (x){ e = x; }
    // est = 1000 tokens; 120 s + 2 x 1000 / 100 tok/s = 140 s
    ok("with a measured prefill rate, firstLineMs = 120 s + 2 x est / rate", seen.armed.includes(140000) && /140s/.test(e && e.message), seen.armed);
  }
  {
    const { M, seen } = harness({ script: [[1, tok("a")], [1, tok("b")]], hang: true });
    let e = null; try { await M.local.chat("local", "m", "hi"); } catch (x){ e = x; }
    ok("a stall after the first line times out on idleMs", e && e.timedOut && seen.armed.includes(180000) && /180s/.test(e.message), e && e.message);
    ok("timeout keeps its retry-once policy", M.retireScope(M.classifyAttempt(e).reason) === "retry");
  }
  {
    const { M } = harness({ script: [[1, tok("a")], [1, tok("b")]], hang: true });
    const ac = new AbortController();
    const p = M.local.chat("local", "m", "hi", { signal: ac.signal, onProgress: () => {} });
    setTimeout(() => ac.abort(), 30);
    let e = null; try { await p; } catch (x){ e = x; }
    ok("Stop mid-stream ends the call as stopped (not 'Request cancelled')", e && e.stopped === true, e);
    const c = M.classifyAttempt(e);
    ok("stopped is its own outcome, checked first", c.outcome === "stopped" && c.reason === "stopped" && c.expected === true, c);
    ok("stopped is never retried or marked dead", M.retireScope("stopped") === "none");
    ok("stopped is not delivered, so nothing is spent", !e.delivered);
  }
  {
    const { M } = harness({ script: [[1, tok("a")]] });
    const ac = new AbortController(); ac.abort();
    let e = null; try { await M.local.chat("local", "m", "hi", { signal: ac.signal }); } catch (x){ e = x; }
    ok("an already-stopped signal stops before anything streams", e && e.stopped === true);
  }

  /* ---- runStage honours `none` and Stop (structural: runStage needs the DOM) ---- */
  {
    const rs = html.slice(html.indexOf("async function runStage("), html.indexOf("window.stopAutoLower"));
    const none = rs.indexOf('if (scope === "none"){'), mark = rs.indexOf("markDead(c)");
    ok("runStage ends the stage on scope none, before any markDead", none > 0 && none < mark);
    ok("...with no fail-over", /if \(scope === "none"\)\{[\s\S]{0,400}c = null; break;/.test(rs));
    ok("only a delivered error is spent", /if \(e && e\.delivered\)\{/.test(rs));
    ok("a stopped run says nothing was saved", /err && err\.stopped[\s\S]{0,200}Nothing was saved for this stage/.test(rs));
    ok("the chat call passes signal, onProgress and metrics",
       /\.chat\(S\.keys\[c\.provider\], c\.id, promptOf\(\),[^\n]*\n\s*\{ signal: RUN\.signal, onProgress: showProgress, metrics \}\)/.test(rs));   // promptOf: 2026-11-18 (quality-gate revision note)
    // 2026-11-18 (security study F3): Stop is offered for every run; on a cloud run it says the call is counted.
    ok("Stop is offered for every run, and says a cloud call is already counted",
       /\$\("btn-stop"\)\.hidden = false;/.test(rs) && /keyless \? "Stop" : "Stop \(this call is already counted\)"/.test(rs));
  }

  console.log(fail ? `desktop-chat.test.js: ${pass} passed, ${fail} FAILED`
                   : `desktop-chat.test.js: ${pass} assertions passed`);
  process.exit(fail ? 1 : 0);
})();
