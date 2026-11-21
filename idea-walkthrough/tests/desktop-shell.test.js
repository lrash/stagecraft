#!/usr/bin/env node
// DESIGN-desktop step 2 (A-3, A-4): the desktop section of index.html.
//  A-3: without __TAURI__ it does nothing - no global, fetch untouched - and it runs under vm
//       with no `window` at all.
//  A-4: with a mocked Tauri, the fetch shim routes http(s) through plugin-http with an empty
//       Origin and no redirects, keeps ipc:/blob:/IPC native, turns a plugin abort into an
//       AbortError, and the storage backing saves one at a time with the latest value winning.
//   Run:  node tests/desktop-shell.test.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const a = html.indexOf("/* ---------- desktop shell (Tauri)");
const b = html.indexOf('const LS = "stagecraft.v1";');
const SECTION = html.slice(a, b);

let pass = 0, fail = 0;
const ok = (n, c, got) => c ? pass++ : (fail++, console.log("FAIL  " + n + (got !== undefined ? "\n      " + JSON.stringify(got) : "")));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

ok("the section exists, after the frame guard and before const LS",
   a > html.indexOf('throw new Error("framed")') && b > a);
ok("it is the only place IN_TAURI is declared", (html.match(/const IN_TAURI/g) || []).length === 1);

// Outside the section the desktop is reached only through globalThis.__stagecraftDesktop.
{
  const outside = html.slice(0, a) + html.slice(b);
  ok("no bare top-level SCD outside the section",
     !/^\s*SCD[.\s=]/m.test(outside.replace(/const SCD = globalThis\.__stagecraftDesktop;[\s\S]*?\n\}/g, "")));
  ok("no window.__TAURI__ outside the section", !/__TAURI__/.test(outside.replace(/<script[\s\S]*?"use strict";/, "")));
}

/* ---- A-3: browser / plain Node ------------------------------------------------- */
{
  const nf = () => "native";
  const ctx = vm.createContext({ fetch: nf, setTimeout, clearTimeout });
  let threw = null;
  try { vm.runInContext(SECTION, ctx); } catch (e){ threw = e; }
  ok("runs under vm with no window and no __TAURI__", !threw, threw && threw.message);
  ok("sets no __stagecraftDesktop", ctx.__stagecraftDesktop === undefined);
  ok("leaves fetch alone", ctx.fetch === nf);
  ok("IN_TAURI is false", vm.runInContext("IN_TAURI", ctx) === false);
}

/* ---- A-4: mocked Tauri ------------------------------------------------------------ */
function tauriCtx(boot, opts = {}){
  const calls = { http: [], native: [], invoke: [], listen: [] };
  const saves = [];
  const T = {
    core: { invoke: (cmd, args) => {
      calls.invoke.push([cmd, args]);
      if (cmd === "state_save"){
        return new Promise((res, rej) => saves.push({ args, res, rej }));
      }
      if (cmd === "save_export") return Promise.resolve(opts.exportPath === undefined ? "/tmp/x.md" : opts.exportPath);
      if (cmd === "cloud_fetch") return Promise.reject("Command cloud_fetch not allowed by ACL");   // cloud off
      return Promise.resolve(null);
    } },
    http: { fetch: async (url, init) => {
      calls.http.push({ url, init });
      if (/example\.com/.test(url)) throw new Error("url not allowed on the configured scope: " + url);
      if (init.signal && init.signal.aborted) throw new Error("Request cancelled");
      if (/hang/.test(url)) return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("Request cancelled"))));
      return { ok: true, status: 200, url };
    } },
    event: { listen: (ev, fn) => { calls.listen.push(ev); return Promise.resolve(() => {}); } },
    dialog: { ask: async () => true },
    opener: { openUrl: async () => {} },
  };
  const ctx = vm.createContext({
    __TAURI__: T, isTauri: true, __STAGECRAFT_BOOT__: boot,
    fetch: (u, i) => { calls.native.push(String(u)); return Promise.resolve("native"); },
    Headers, Request, Response, DOMException, AbortController, setTimeout, clearTimeout, URL, Promise,
  });
  vm.runInContext(SECTION, ctx);
  return { ctx, SCD: ctx.__stagecraftDesktop, calls, saves };
}

(async () => {
  const { ctx, SCD, calls, saves } = tauriCtx({ state: '{"idea":"x","__doc":"tauri://localhost/index.html"}', persistent: true, gen: 1, os: "linux" });
  ok("sets __stagecraftDesktop in Tauri", !!SCD && SCD.gen === 1 && SCD.os === "linux");
  ok("bootSeen records the injected boot object", SCD.bootSeen === true);
  ok("v1 allows local and nothing else",
     SCD.allows("local") === true && SCD.allows("openrouter") === false && SCD.allows("groq") === false);
  ok("the close protocol listens for scd-flush", calls.listen.includes("scd-flush"));

  // fetch shim
  await ctx.fetch("http://127.0.0.1:11434/api/tags", { headers: { "Content-Type": "application/json" } });
  const h = calls.http[0];
  ok("an Ollama URL goes through plugin-http", h && h.url === "http://127.0.0.1:11434/api/tags");
  ok("...with Origin set to empty (the plugin then drops it)", h && h.init.headers.get("Origin") === "", h && [...h.init.headers]);
  ok("...keeping the caller's headers", h && h.init.headers.get("content-type") === "application/json");
  ok("...and never following redirects", h && h.init.maxRedirections === 0);

  /* R-12 amendment (v2-4, DESIGN §13.8): a cloud URL goes to Rust's cloud_fetch, never to the
     plugin; the "scope rejection propagates" case now uses a non-cloud https URL. */
  let aclErr = null;
  try { await ctx.fetch("https://openrouter.ai/api/v1/" + "models", { headers: { Authorization: "Bearer keychain" } }); } catch (e){ aclErr = e; }
  const cf = calls.invoke.find(c => c[0] === "cloud_fetch");
  ok("a cloud URL goes to invoke('cloud_fetch'), not the plugin", !!cf && !calls.http.some(c => /openrouter/.test(c.url)), calls.invoke);
  ok("...with the provider and path, and no headers", cf && cf[1].provider === "openrouter" && cf[1].path === "/api/v1/models"
     && cf[1].method === "GET" && !("headers" in cf[1]) && !JSON.stringify(cf[1]).includes("keychain"), cf && cf[1]);
  ok("...and the ACL's refusal (cloud off) propagates", aclErr && /not allowed/.test(aclErr.message), aclErr && aclErr.message);
  let scopeErr = null;
  try { await ctx.fetch("https://example.com/x"); } catch (e){ scopeErr = e; }
  ok("a non-cloud https URL reaches the plugin", calls.http.some(c => /example\.com/.test(c.url)));
  ok("...and the scope's refusal propagates", scopeErr && /not allowed/.test(scopeErr.message), scopeErr && scopeErr.message);

  for (const u of ["ipc://localhost/plugin%3Ahttp%7Cfetch", "blob:tauri://localhost/abc", "data:text/plain,x", "http://ipc.localhost/plugin%3Ahttp%7Cfetch"]){
    calls.native.length = 0; const before = calls.http.length;
    const r = await ctx.fetch(u);
    ok("stays native: " + u.slice(0, 26), r === "native" && calls.native.length === 1 && calls.http.length === before);
  }

  // abort -> AbortError -> fetchWithTimeout says timeout
  {
    const ac = new AbortController();
    const p = ctx.fetch("http://127.0.0.1:11434/hang", { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    let e = null; try { await p; } catch (x){ e = x; }
    ok("a plugin abort surfaces as AbortError", e && e.name === "AbortError", e && (e.name + ": " + e.message));
    const ta = html.indexOf("const DEFAULT_TIMEOUT_MS"), tb = html.indexOf("/* A timeout is NOT a transport error.");
    const tc = html.indexOf("function timeoutFail(ms){"), td = html.indexOf("/* Parse the body WITHOUT");
    const FWT = new Function("fetch", html.slice(ta, tb) + html.slice(tc, td) + "\nreturn fetchWithTimeout;")(ctx.fetch);
    let te = null; try { await FWT("http://127.0.0.1:11434/hang", {}, 30); } catch (x){ te = x; }
    ok("so fetchWithTimeout classifies it as a timeout", te && te.timedOut === true, te && te.message);
  }

  // backing
  const B = SCD.backing;
  ok("getItem returns the boot state without __doc", JSON.parse(B.getItem("stagecraft.v1")).__doc === undefined
     && JSON.parse(B.getItem("stagecraft.v1")).idea === "x");
  B.setItem("stagecraft.v1.probe", "1");
  ok(".probe is stored when Rust's canary write succeeded", B.getItem("stagecraft.v1.probe") === "1");
  {
    const t2 = tauriCtx({ state: null, persistent: false, gen: 1 });
    t2.SCD.backing.setItem("stagecraft.v1.probe", "1");
    ok(".probe is NOT stored when it failed, so store.usable() is false", t2.SCD.backing.getItem("stagecraft.v1.probe") === null);
  }
  B.setItem("other.key", "v");
  ok("other keys are not stored", B.getItem("other.key") === null);

  B.setItem("stagecraft.v1", JSON.stringify({ idea: "one" }));
  ok("a set marks the state pending", SCD.pending === true);
  ok("...and is debounced, not sent at once", saves.length === 0);
  await tick(300);
  ok("after the debounce one save is sent", saves.length === 1, saves.length);
  ok("...carrying the generation", saves[0] && saves[0].args.gen === 1);
  B.setItem("stagecraft.v1", JSON.stringify({ idea: "two" }));
  B.setItem("stagecraft.v1", JSON.stringify({ idea: "three" }));
  await tick(300);
  ok("only one save is in flight at a time", saves.length === 1, saves.length);
  saves[0].res(1700000000000);
  await tick(5);
  ok("the queued value is sent after it lands, and only the latest", saves.length === 2 && JSON.parse(saves[1].args.json).idea === "three",
     saves.map(s => s.args.json));
  ok("lastSavedAt comes from Rust", SCD.lastSavedAt === 1700000000000);
  ok("still pending while the second is in flight", SCD.pending === true);
  saves[1].rej("disk full");
  await tick(5);
  ok("a failed save is recorded, not hidden", SCD.writeError === "disk full", SCD.writeError);
  ok("...and nothing is pending after it", SCD.pending === false);

  // removeItem cancels a pending debounced save
  B.setItem("stagecraft.v1", JSON.stringify({ idea: "four" }));
  B.removeItem("stagecraft.v1");
  ok("removeItem sends the delete at once", saves.length === 3 && saves[2].args.json === null, saves.map(s => s.args.json));
  await tick(300);
  ok("...and the pending value is dropped, never sent", saves.length === 3, saves.length);
  saves[2].res(1);
  await tick(5);
  ok("getItem is empty after removeItem", B.getItem("stagecraft.v1") === null);

  // flush awaits the save
  B.setItem("stagecraft.v1", JSON.stringify({ idea: "five" }));
  let flushed = false; const fp = SCD.flush().then(() => flushed = true);
  await tick(5);
  ok("flush sends at once without waiting for the debounce", saves.length === 4);
  ok("...and has not resolved before the save lands", flushed === false);
  saves[3].res(2); await fp;
  ok("flush resolves once the save landed", flushed === true && SCD.pending === false);

  // exports
  ok("saveExport reports the saved path", JSON.stringify(await SCD.saveExport("a.md", "x")) === JSON.stringify({ saved: true, path: "/tmp/x.md" }));
  ok("saveExport reports a cancel as not saved",
     JSON.stringify(await tauriCtx({}, { exportPath: null }).SCD.saveExport("a.md", "x")) === JSON.stringify({ saved: false }));

  // self-test answers its own dialogs
  ok("under self-test ask() answers from the spec", (await tauriCtx({ selftest: { dialog: "no" } }).SCD.ask("?")) === false
     && (await tauriCtx({ selftest: { dialog: "yes" } }).SCD.ask("?")) === true);

  console.log(fail ? `desktop-shell.test.js: ${pass} passed, ${fail} FAILED`
                   : `desktop-shell.test.js: ${pass} assertions passed`);
  process.exit(fail ? 1 : 0);
})();
