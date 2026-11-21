#!/usr/bin/env node
// D-26: the mock cloud provider. No real internet, no real keys. A debug build with
// STAGECRAFT_SELFTEST_MOCKCLOUD=<port> rewrites every endpoint origin to
// http://127.0.0.1:<port>/<provider> and keeps the paths, so this serves the seven R-88 paths
// under /openrouter, /groq and /gemini, in each provider's JSON shapes.
//
//   node tests/fixtures/mock-cloud.js <port>        (MOCK_LOG=<file> appends one JSON line per request)
//   POST /__mode {"provider":"groq","mode":"429","only":"chat"}   per provider; "only" is optional
//     modes: ok | 401 | 403 | 400-invalid-key | 404-data-policy | 429 | 500 | slow | redirect | huge | echo-key | reset
//     (reset: a 200 whose body is cut off mid-read by a connection reset)
//   GET  /__ping                                     readiness; not logged
//
// Each logged line: { method, path, provider, kind, headers, keyKind, bodySha256, promptSha256, model, status }
// A key is never logged (v2 review): `headers.authorization` is "Bearer sha256:<hex>" and
// `headers["x-goog-api-key"]` is "sha256:<hex>", and keyKind is "test-key:<provider>" for a
// test key (test-only-<provider>-…), otherwise "other".
// and { aborted: true, path } when the connection closes before the answer was sent.
// No dependencies; Node 18.
"use strict";
const http = require("http"), crypto = require("crypto"), fs = require("fs");
const PORT = +process.argv[2] || 11500;
const LOG = process.env.MOCK_LOG || "";
const modes = {};                                   // provider -> { mode, only }
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const log = rec => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(rec) + "\n"); };

const FREE = { prompt: "0", completion: "0", request: "0", image: "0", web_search: "0", internal_reasoning: "0" };
const MODELS = {
  openrouter: [
    { id: "mock/llama-3.3-70b-instruct:free", pricing: FREE },                 // high, free
    { id: "mock/qwen-2.5-14b-instruct:free", pricing: FREE },                  // medium, free
    { id: "mock/llama-3.2-3b-instruct:free", pricing: FREE },                  // low, free
    { id: "mock/llama-3.1-405b-instruct", pricing: Object.assign({}, FREE, { prompt: "0.000003", completion: "0.000003" }) }, // paid
    { id: "mock/hermes-3-8b-request:free", pricing: Object.assign({}, FREE, { request: "0.02" }) },    // only `request` is priced (low tier, so it never wins a high stage)
  ],
  groq: [ { id: "llama-3.3-70b-versatile" }, { id: "qwen-2.5-32b" }, { id: "llama-3.1-8b-instant" } ],
  gemini: [
    [ { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] } ],
    [ { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] } ],
  ],
};

function kindOf(provider, method, path){
  if (method === "POST") return "chat";
  if (provider === "openrouter" && path.startsWith("/api/v1/key")) return "probe";
  return "list";
}
function keyOf(h){
  const a = h["authorization"] || "";
  return a.startsWith("Bearer ") ? a.slice(7) : (h["x-goog-api-key"] || "");
}
function promptOf(provider, body){
  try {
    const j = JSON.parse(body);
    if (provider === "gemini") return { prompt: j.contents[0].parts[0].text, model: null };
    return { prompt: j.messages[0].content, model: j.model };
  } catch { return { prompt: null, model: null }; }
}
function errBody(provider, status, message, extra){
  if (provider === "gemini") return Object.assign({ error: { code: status, message, status: status === 400 ? "INVALID_ARGUMENT" : "ERROR" } }, extra || {});
  return { error: Object.assign({ message, code: status }, extra || {}) };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => handle(req, res, Buffer.concat(chunks)));
});

function send(res, status, obj, headers){
  if (res.writableEnded || res.destroyed) return;
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(status, Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(body) }, headers || {}));
  res.end(body);
}

function handle(req, res, raw){
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/__ping") return send(res, 200, { ok: true });
  if (u.pathname === "/__mode" && req.method === "POST"){
    try { const j = JSON.parse(raw.toString("utf8")); modes[j.provider] = { mode: j.mode || "ok", only: j.only || null }; }
    catch { return send(res, 400, { error: "bad mode" }); }
    return send(res, 200, { ok: true, modes });
  }
  const m = u.pathname.match(/^\/(openrouter|groq|gemini)(\/.*)$/);
  const provider = m ? m[1] : null, path = m ? m[2] : u.pathname;
  const kind = provider ? kindOf(provider, req.method, path) : "unknown";
  const body = raw.toString("utf8");
  const { prompt, model } = provider && req.method === "POST" ? promptOf(provider, body) : { prompt: null, model: null };
  const key = keyOf(req.headers);
  const headers = Object.assign({}, req.headers);
  if (headers.authorization) headers.authorization = headers.authorization.startsWith("Bearer ") ? "Bearer sha256:" + sha(key) : "sha256:" + sha(headers.authorization);
  if (headers["x-goog-api-key"]) headers["x-goog-api-key"] = "sha256:" + sha(headers["x-goog-api-key"]);
  const keyKind = !key ? null : (key.match(/^test-only-([a-z]+)-/) ? "test-key:" + key.match(/^test-only-([a-z]+)-/)[1] : "other");
  const rec = { t: Date.now(), method: req.method, path: u.pathname + u.search, provider, kind, headers, keyKind,
                bodySha256: raw.length ? sha(raw) : null, promptSha256: prompt == null ? null : sha(Buffer.from(prompt, "utf8")),
                model: model || (path.match(/^\/v1beta\/models\/([^:]+):generateContent$/) || [])[1] || null };
  res.on("close", () => { if (!res.writableEnded) log({ t: Date.now(), aborted: true, path: rec.path, provider }); });
  if (!provider) { rec.status = 404; log(rec); return send(res, 404, { error: "not a mock path" }); }
  const md = modes[provider] && (!modes[provider].only || modes[provider].only === kind) ? modes[provider].mode : "ok";
  const answer = (status, obj, headers) => { rec.status = status; log(rec); send(res, status, obj, headers); };
  switch (md){
    case "401": return answer(401, errBody(provider, 401, "Invalid API Key"));
    case "403": return answer(403, errBody(provider, 403, "Forbidden"));
    case "400-invalid-key":
      return answer(400, provider === "gemini"
        ? { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT",
                     details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }] } }
        : errBody(provider, 400, "API key not valid"));
    case "404-data-policy":
      return answer(404, errBody(provider, 404, "No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy"));
    case "429": return answer(429, errBody(provider, 429, "Rate limit reached for model. Please try again later."),
                              { "retry-after": "60", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "3h12m", "set-cookie": "mock=1" });
    case "500": return answer(500, errBody(provider, 500, "Internal server error"));
    case "redirect": rec.status = 302; log(rec); res.writeHead(302, { location: "http://127.0.0.1:" + PORT + "/elsewhere" }); return res.end();
    case "huge": return answer(200, JSON.stringify({ pad: "x".repeat(9 * 1024 * 1024) }));
    case "echo-key": return answer(401, errBody(provider, 401, "Incorrect API key provided: " + keyOf(req.headers) + ". You can find your API key in your dashboard."));
    case "slow": rec.status = "slow"; log(rec); return setTimeout(() => ok(), 60000);
    case "reset":
      rec.status = 200; log(rec);
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"choices":[{"message":{"content":"cut off');
      return setTimeout(() => res.socket && res.socket.destroy(), 50);
  }
  return ok();

  function ok(){
    const st = res.writableEnded ? null : 200;
    if (st === null) return;
    if (md !== "slow") rec.status = 200;
    const headers = { "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "999", "set-cookie": "mock=1", "x-mock-extra": "dropped" };
    if (kind === "chat"){
      const text = "MOCK ANSWER from " + provider + " (" + (rec.model || "?") + ")\n\nprompt sha256 " + rec.promptSha256 + "\n\n- point one\n- point two";
      const out = provider === "gemini"
        ? { candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP" }] }
        : { id: "mock-1", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] };
      if (md !== "slow") log(rec);
      return send(res, 200, out, headers);
    }
    let out;
    if (provider === "openrouter") out = path.startsWith("/api/v1/key") ? { data: { label: "mock-key", usage: 0, limit: null, is_free_tier: true } }
                                                                       : { data: MODELS.openrouter };
    else if (provider === "groq") out = { object: "list", data: MODELS.groq.map(x => Object.assign({ object: "model" }, x)) };
    else out = u.searchParams.get("pageToken") === "page-2" ? { models: MODELS.gemini[1] } : { models: MODELS.gemini[0], nextPageToken: "page-2" };
    if (md !== "slow") log(rec);
    send(res, 200, out, headers);
  }
}

if (require.main === module) server.listen(PORT, "127.0.0.1", () => process.stdout.write("mock-cloud listening on 127.0.0.1:" + PORT + "\n"));
module.exports = { MODELS };                       // the page's unit tests read the catalogue
