#!/usr/bin/env node
// A-6b fixture (DESIGN-desktop §9): a tiny HTTP server that logs every request it receives,
// headers included, so a debug desktop build can prove what plugin-http actually sends.
//   node tests/fixtures/echo-server.js 11435        (one JSON line per request on stdout)
//   GET /echo  -> 200, the request's own headers as JSON
//   GET /slow  -> answers after 5 s (used to show an abort lands as AbortError)
const http = require("http");
const port = +(process.argv[2] || 11435);
http.createServer((req, res) => {
  const rec = { at: Date.now(), method: req.method, url: req.url, headers: req.headers,
                hasOrigin: Object.prototype.hasOwnProperty.call(req.headers, "origin") };
  console.log(JSON.stringify(rec));
  const send = () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(rec)); };
  if (req.url.startsWith("/slow")) { const t = setTimeout(send, 5000); req.on("close", () => clearTimeout(t)); }
  else send();
}).listen(port, "127.0.0.1", () => console.error("echo-server listening on 127.0.0.1:" + port));
