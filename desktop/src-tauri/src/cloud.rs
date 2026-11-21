//! v2: cloud requests (DESIGN-desktop §13.3, D-25, R-88, R-89, R-104, R-105).
//!
//! Cloud traffic never uses plugin-http. The page asks Rust, through `cloud_fetch`, for one row
//! of a compiled endpoint table; Rust builds the URL, rebuilds the body from an allowlist,
//! attaches the key itself, sends the request with no proxy, no cookies and no redirects, and
//! returns a redacted reply. Everything is refused unless the gate is open for that provider.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri_plugin_http::reqwest;

use crate::gate::{CloudState, GateState, Inflight, Provider};
use crate::secrets::{self, Choice, KeyCheck, Keystore};
use crate::state;

/* ---------- R-88: the endpoint table ---------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Authenticates a key (OpenRouter's `/key`).
    Probe,
    /// Lists models; also the probe where a provider has no `/key`.
    List,
    Chat,
}

#[derive(Debug)]
pub struct Row {
    pub provider: Provider,
    pub method: &'static str,
    /// `{model}` is the only parameter.
    pub path: &'static str,
    /// A query Rust appends itself. The page can never send one.
    pub query: Option<&'static str>,
    pub kind: Kind,
}

pub const ENDPOINTS: [Row; 7] = [
    Row { provider: Provider::Openrouter, method: "GET", path: "/api/v1/key", query: None, kind: Kind::Probe },
    Row { provider: Provider::Openrouter, method: "GET", path: "/api/v1/models", query: None, kind: Kind::List },
    Row { provider: Provider::Openrouter, method: "POST", path: "/api/v1/chat/completions", query: None, kind: Kind::Chat },
    Row { provider: Provider::Groq, method: "GET", path: "/openai/v1/models", query: None, kind: Kind::List },
    Row { provider: Provider::Groq, method: "POST", path: "/openai/v1/chat/completions", query: None, kind: Kind::Chat },
    Row { provider: Provider::Gemini, method: "GET", path: "/v1beta/models", query: Some("pageSize=1000"), kind: Kind::List },
    Row { provider: Provider::Gemini, method: "POST", path: "/v1beta/models/{model}:generateContent", query: None, kind: Kind::Chat },
];

pub fn real_origin(p: Provider) -> &'static str {
    match p {
        Provider::Openrouter => "https://openrouter.ai",
        Provider::Groq => "https://api.groq.com",
        Provider::Gemini => "https://generativelanguage.googleapis.com",
    }
}

/// Where requests go. `Mock` exists only in debug builds (D-26).
#[derive(Clone, Debug, PartialEq)]
pub enum Base {
    Real,
    #[cfg(debug_assertions)]
    Mock(u16),
}

impl Base {
    pub fn origin(&self, p: Provider) -> String {
        match self {
            Base::Real => real_origin(p).to_string(),
            #[cfg(debug_assertions)]
            Base::Mock(port) => format!("http://127.0.0.1:{port}/{}", p.id()),
        }
    }
}

/// The scope entry `cloud.json` repeats for `allow-cloud-fetch`. Rust requires a match in both
/// that scope and `ENDPOINTS`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct CloudEndpoint {
    pub provider: String,
    pub method: String,
    pub path: String,
}

impl CloudEndpoint {
    pub fn matches(&self, row: &Row) -> bool {
        self.provider == row.provider.id() && self.method == row.method && self.path == row.path
    }
}

pub struct Target {
    pub row: &'static Row,
    pub path: String,
}

fn model_ok(m: &str) -> bool {
    let b = m.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// Matches a page path against the table. A query, fragment, `..`, `//`, any `%` escape, a
/// backslash, whitespace or a control character is refused before matching.
pub fn resolve(p: Provider, method: &str, path: &str) -> Result<Target, &'static str> {
    let bad = !path.starts_with('/')
        || path.contains(['?', '#', '%', '\\'])
        || path.contains("..")
        || path.contains("//")
        || path.bytes().any(|b| b <= 0x20 || b >= 0x7f);
    if bad {
        return Err("not-allowed");
    }
    for row in ENDPOINTS.iter().filter(|r| r.provider == p && r.method == method) {
        match row.path.split_once("{model}") {
            None if path == row.path => return Ok(Target { row, path: path.to_string() }),
            None => {}
            Some((pre, suf)) => {
                if let Some(mid) = path.strip_prefix(pre).and_then(|r| r.strip_suffix(suf)) {
                    if model_ok(mid) {
                        return Ok(Target { row, path: path.to_string() });
                    }
                }
            }
        }
    }
    Err("not-allowed")
}

pub fn url_for(base: &Base, t: &Target) -> String {
    let mut u = base.origin(t.row.provider) + &t.path;
    if let Some(q) = t.row.query {
        u.push('?');
        u.push_str(q);
    }
    u
}

/* ---------- R-89: the body allowlist ---------- */

pub const MAX_BODY: usize = 2 * 1024 * 1024;
pub const MAX_REPLY: usize = 8 * 1024 * 1024;

fn only_keys(o: &Map<String, Value>, allowed: &[&str]) -> bool {
    o.keys().all(|k| allowed.contains(&k.as_str()))
}

/// Rebuilds the request body from exactly the keys the page sends today. Any other key, at
/// any level, is `not-allowed`. Returns the body and, for a chat, the model it names.
pub fn rebuild_body(p: Provider, kind: Kind, body: Option<&str>) -> Result<(Option<String>, Option<String>), &'static str> {
    let body = body.unwrap_or("");
    if kind != Kind::Chat {
        return if body.is_empty() { Ok((None, None)) } else { Err("not-allowed") };
    }
    if body.len() > MAX_BODY {
        return Err("too-large");
    }
    let v: Value = serde_json::from_str(body).map_err(|_| "not-allowed")?;
    let o = v.as_object().ok_or("not-allowed")?;
    match p {
        Provider::Openrouter | Provider::Groq => {
            if !only_keys(o, &["model", "messages", "max_tokens"]) {
                return Err("not-allowed");
            }
            let model = o.get("model").and_then(Value::as_str).filter(|m| !m.is_empty() && m.len() <= 200).ok_or("not-allowed")?;
            let msgs = o.get("messages").and_then(Value::as_array).filter(|a| !a.is_empty()).ok_or("not-allowed")?;
            let mut out = vec![];
            for m in msgs {
                let mo = m.as_object().ok_or("not-allowed")?;
                if !only_keys(mo, &["role", "content"]) {
                    return Err("not-allowed");
                }
                let role = mo.get("role").and_then(Value::as_str).filter(|r| ["user", "system", "assistant"].contains(r)).ok_or("not-allowed")?;
                let content = mo.get("content").and_then(Value::as_str).ok_or("not-allowed")?;
                out.push(json!({ "role": role, "content": content }));
            }
            let mut b = json!({ "model": model, "messages": out });
            if let Some(mt) = o.get("max_tokens") {
                let n = mt.as_u64().filter(|n| *n > 0 && *n <= 1_000_000).ok_or("not-allowed")?;
                b["max_tokens"] = json!(n);
            }
            Ok((Some(b.to_string()), Some(model.to_string())))
        }
        Provider::Gemini => {
            if !only_keys(o, &["contents"]) {
                return Err("not-allowed");
            }
            let contents = o.get("contents").and_then(Value::as_array).filter(|a| !a.is_empty()).ok_or("not-allowed")?;
            let mut out = vec![];
            for c in contents {
                let co = c.as_object().ok_or("not-allowed")?;
                if !only_keys(co, &["role", "parts"]) {
                    return Err("not-allowed");
                }
                let parts = co.get("parts").and_then(Value::as_array).filter(|a| !a.is_empty()).ok_or("not-allowed")?;
                let mut ps = vec![];
                for part in parts {
                    let po = part.as_object().ok_or("not-allowed")?;
                    if !only_keys(po, &["text"]) {
                        return Err("not-allowed");
                    }
                    ps.push(json!({ "text": po.get("text").and_then(Value::as_str).ok_or("not-allowed")? }));
                }
                let mut entry = json!({ "parts": ps });
                if let Some(r) = co.get("role") {
                    let r = r.as_str().filter(|r| ["user", "model"].contains(r)).ok_or("not-allowed")?;
                    entry["role"] = json!(r);
                }
                out.push(entry);
            }
            Ok((Some(json!({ "contents": out }).to_string()), None))
        }
    }
}

/* ---------- R-105: key redaction ---------- */

/// Replaces the key, and every substring of it of 8 or more characters, with `[key]`.
pub fn redact(text: &str, key: &str) -> String {
    let k = key.as_bytes();
    if k.len() < 8 || text.len() < 8 {
        return text.to_string();
    }
    let mut windows: std::collections::HashMap<&[u8], Vec<usize>> = std::collections::HashMap::new();
    for j in 0..=k.len() - 8 {
        windows.entry(&k[j..j + 8]).or_default().push(j);
    }
    let t = text.as_bytes();
    let mut out = Vec::with_capacity(t.len());
    let mut i = 0;
    while i < t.len() {
        if i + 8 <= t.len() {
            if let Some(starts) = windows.get(&t[i..i + 8]) {
                let mut best = 8;
                for &j in starts {
                    let mut l = 8;
                    while i + l < t.len() && j + l < k.len() && t[i + l] == k[j + l] {
                        l += 1;
                    }
                    best = best.max(l);
                }
                out.extend_from_slice(b"[key]");
                i += best;
                continue;
            }
        }
        out.push(t[i]);
        i += 1;
    }
    // Only ASCII spans were replaced, so the text is still UTF-8.
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/* ---------- R-104: OpenRouter's free list ---------- */

fn is_zero(v: &Value) -> bool {
    match v {
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.trim().parse::<f64>().map(|f| f == 0.0).unwrap_or(false),
        _ => false,
    }
}

/// The ids whose EVERY `pricing` field is 0. A model with no pricing, or an empty one, is not
/// free.
pub fn free_ids(body: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(v) = serde_json::from_str::<Value>(body) else { return out };
    for m in v.get("data").and_then(Value::as_array).into_iter().flatten() {
        let (Some(id), Some(pr)) = (m.get("id").and_then(Value::as_str), m.get("pricing").and_then(Value::as_object)) else {
            continue;
        };
        if !pr.is_empty() && pr.values().all(is_zero) {
            out.insert(id.to_string());
        }
    }
    out
}

pub const FREE_LIST_MAX_AGE: Duration = Duration::from_secs(6 * 3600);
/// R1 (security study, 2026-11-18): a hard ceiling on chat calls per provider per UTC day, kept in
/// Rust and in settings.json so it survives a relaunch. Set at or above each free tier's own most
/// generous daily allowance (OpenRouter 1000/day with credits bought), so it never bites in normal
/// use; it exists to stop a runaway loop, not to replace the page's quota ledger.
pub fn daily_ceiling(p: Provider) -> u32 {
    match p {
        Provider::Openrouter => 1000,
        Provider::Groq => 1000,
        Provider::Gemini => 500,
    }
}
fn utc_day() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0)
}
/// Counts one chat call against the day's ceiling; Err("budget") once it is reached.
pub fn spend_call(calls: &mut std::collections::BTreeMap<String, (u64, u32)>, p: Provider, day: u64) -> Result<(), String> {
    let e = calls.entry(p.id().to_string()).or_insert((day, 0));
    if e.0 != day {
        *e = (day, 0);
    }
    if e.1 >= daily_ceiling(p) {
        return Err("budget".into());
    }
    e.1 += 1;
    Ok(())
}

/* ---------- R-89: the request ---------- */

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CloudResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

pub fn client(version: &str) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .user_agent(format!("Stagecraft/{version}"))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn keep_header(name: &str) -> bool {
    name == "content-type" || name == "retry-after" || name.starts_with("x-ratelimit-")
}

/// A transport error before any status arrived. A connect failure (refused, DNS, or reqwest's
/// connect timeout, which is also `is_timeout`) never reached the provider: `unreachable`, not
/// counted. Any other timeout may have: `timeout`, counted (v2 review).
fn before_status(e: &reqwest::Error) -> &'static str {
    if e.is_connect() {
        "unreachable"
    } else if e.is_timeout() {
        "timeout"
    } else {
        "unreachable"
    }
}

/// One request. `sent` turns true just before the request is handed to the network.
/// Errors after a status arrived carry it and are delivered (R-106, v2 review): a reply over
/// 8 MB is `reply-too-large:<status>` (a request over 2 MB stays `too-large`, unsent), and a
/// body cut off mid-read is `interrupted:<status>`.
pub async fn send(
    client: &reqwest::Client,
    url: &str,
    row: &Row,
    key: Option<&str>,
    body: Option<String>,
    sent: &AtomicBool,
) -> Result<CloudResponse, String> {
    let mut rb = if row.method == "POST" { client.post(url) } else { client.get(url) };
    if let Some(k) = key {
        rb = match row.provider {
            Provider::Gemini => rb.header("x-goog-api-key", k),
            _ => rb.header("authorization", format!("Bearer {k}")),
        };
    }
    if row.provider == Provider::Openrouter {
        rb = rb.header("x-title", "Stagecraft");
    }
    if let Some(b) = body {
        rb = rb.header("content-type", "application/json").body(b);
    }
    sent.store(true, Ordering::SeqCst);
    let mut r = rb.send().await.map_err(|e| before_status(&e).to_string())?;
    let status = r.status().as_u16();
    let headers: Vec<(String, String)> = r
        .headers()
        .iter()
        .filter(|(n, _)| keep_header(n.as_str()))
        .map(|(n, v)| (n.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let mut buf: Vec<u8> = vec![];
    loop {
        match r.chunk().await {
            Ok(Some(c)) => {
                if buf.len() + c.len() > MAX_REPLY {
                    return Err(format!("reply-too-large:{status}"));
                }
                buf.extend_from_slice(&c);
            }
            Ok(None) => break,
            Err(e) => return Err(if e.is_timeout() { "timeout".to_string() } else { format!("interrupted:{status}") }),
        }
    }
    Ok(CloudResponse { status, headers, body: String::from_utf8_lossy(&buf).into_owned() })
}

fn page_token_ok(t: &str) -> bool {
    !t.is_empty() && t.len() <= 512 && t.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'='))
}

/* ---------- the engine the commands call ---------- */

pub type Emitter = Box<dyn Fn(&CloudState) + Send + Sync>;

pub struct Cloud {
    pub gate: Mutex<GateState>,
    pub ks: Keystore,
    pub dir: PathBuf,
    pub base: Base,
    /// D-26: a debug build given test keys or a test keystore but no mock refuses every
    /// request, so a test key can never reach a real host.
    pub fail_closed: bool,
    pub client: reqwest::Client,
    pub emit: Mutex<Option<Emitter>>,
}

impl Cloud {
    pub fn new(gate: GateState, ks: Keystore, dir: PathBuf, base: Base, fail_closed: bool, version: &str) -> Cloud {
        Cloud { gate: Mutex::new(gate), ks, dir, base, fail_closed, client: client(version), emit: Mutex::new(None) }
    }

    pub fn lock(&self) -> MutexGuard<'_, GateState> {
        self.gate.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot(&self) -> CloudState {
        self.lock().snapshot()
    }

    /// Writes `settings.json` and emits the new state to every window (R-110).
    pub fn changed(&self) -> CloudState {
        let st = {
            let g = self.lock();
            let _ = state::save_settings(&self.dir, &g.settings);
            g.snapshot()
        };
        if let Some(f) = self.emit.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            f(&st);
        }
        st
    }

    /// After the user's Yes to R-84.
    pub fn open_gate(&self) {
        let mut g = self.lock();
        g.on = true;
        g.settings.cloud_opt_in = true;
        g.settings.opt_in_at = Some(now_ms());
    }

    /// R-87 step 2: every in-flight request in scope ends now, as `cancelled:sent|unsent`.
    fn cancel_in(g: &mut GateState, which: Option<Provider>) {
        let keys: Vec<(String, u32)> =
            g.inflight.iter().filter(|(_, f)| which.is_none_or(|p| f.provider == p)).map(|(k, _)| k.clone()).collect();
        for k in keys {
            if let Some(mut f) = g.inflight.remove(&k) {
                if let Some(tx) = f.cancel.take() {
                    let _ = tx.send(());
                }
            }
        }
    }

    /// R-87, in one call. `forget` (R-38) also deletes every key from every store,
    /// `keys.json` and `settings.json`. Blocking when `forget` is set.
    pub fn disable(&self, forget: bool) -> CloudState {
        {
            let mut g = self.lock();
            g.on = false;
            Cloud::cancel_in(&mut g, None);
            g.keys.clear();
            g.settings.cloud_opt_in = false;
            for p in Provider::ALL {
                g.set_enabled(p, false); // a later opt-in enables nothing silently
            }
            if forget {
                g.session_keys.clear();
                g.file_ok.clear();
                g.free_openrouter = None;
            }
        }
        if forget {
            let (touched_keychain, recorded) = {
                let g = self.lock();
                let recorded: Vec<Provider> = Provider::ALL.into_iter().filter(|p| g.stored(*p).as_deref() == Some("keychain")).collect();
                (!recorded.is_empty() || g.keystore == "keychain", recorded)
            };
            // settings.json is the only record that a keychain key exists (the keychain is never
            // probed at a cloud-off boot, R-94). So a keychain delete that is not confirmed keeps
            // that provider's record, and the next boot still offers [Delete them] (v2 review).
            let mut undeleted = vec![];
            if touched_keychain {
                for p in Provider::ALL {
                    if self.ks.delete(p).is_err() && recorded.contains(&p) {
                        undeleted.push(p);
                    }
                }
            }
            let _ = state::remove_named(&self.dir, state::KEYS_FILE);
            let mut kept = state::Settings::default();
            for p in &undeleted {
                kept.providers.insert(p.id().to_string(), state::ProviderSettings { enabled: false, stored: Some("keychain".into()) });
            }
            if undeleted.is_empty() {
                let _ = state::remove_named(&self.dir, state::SETTINGS);
            } else {
                let _ = state::save_settings(&self.dir, &kept);
            }
            let mut g = self.lock();
            g.settings = kept;
            g.scrubbed.clear();
            let st = g.snapshot();
            drop(g);
            if let Some(f) = self.emit.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                f(&st);
            }
            return st;
        }
        self.changed()
    }

    pub fn provider_set(&self, p: Provider, enabled: bool) -> Result<CloudState, String> {
        {
            let mut g = self.lock();
            if !g.on {
                return Err("cloud-off".into());
            }
            g.set_enabled(p, enabled);
            if !enabled {
                Cloud::cancel_in(&mut g, Some(p));
                g.keys.remove(&p); // the cached copy; the stored key stays (R-87)
            }
        }
        Ok(self.changed())
    }

    /// D-4: a window being replaced (a reload) cancels everything it still had running. A
    /// request already sent was counted by the provider, so its provider is kept in
    /// `unrecorded`, which the replacement window's boot object carries to the new page's
    /// ledger (v2 review).
    pub fn cancel_label(&self, label: &str) -> usize {
        let mut g = self.lock();
        let keys: Vec<(String, u32)> = g.inflight.keys().filter(|(l, _)| l == label).cloned().collect();
        let n = keys.len();
        for k in keys {
            if let Some(mut f) = g.inflight.remove(&k) {
                if f.sent.load(Ordering::SeqCst) {
                    *g.unrecorded.entry(f.provider.id().to_string()).or_insert(0) += 1;
                }
                if let Some(tx) = f.cancel.take() {
                    let _ = tx.send(());
                }
            }
        }
        n
    }

    /// Cancels the caller's own request only. True when one was running.
    pub fn cancel(&self, label: &str, req_id: u32) -> bool {
        let mut g = self.lock();
        match g.inflight.remove(&(label.to_string(), req_id)) {
            Some(mut f) => {
                if let Some(tx) = f.cancel.take() {
                    let _ = tx.send(());
                }
                true
            }
            None => false,
        }
    }

    pub(crate) fn check_gate(&self, p: Provider) -> Result<(), String> {
        let g = self.lock();
        if !g.on {
            return Err("cloud-off".into());
        }
        if !g.enabled.contains(&p) {
            return Err("not-enabled".into());
        }
        Ok(())
    }

    fn all_keys(&self) -> Vec<String> {
        let g = self.lock();
        g.keys.values().chain(g.session_keys.values()).cloned().collect()
    }

    fn redact_reply(&self, mut r: CloudResponse, used: Option<&str>) -> CloudResponse {
        let mut keys = self.all_keys();
        if let Some(k) = used {
            keys.push(k.to_string());
        }
        for k in &keys {
            r.body = redact(&r.body, k);
            for h in r.headers.iter_mut() {
                h.1 = redact(&h.1, k);
            }
        }
        r
    }

    /// The key for `p`, looked up off the async runtime (the keystore may block on a prompt).
    async fn key_for(self: &Arc<Self>, p: Provider) -> Option<String> {
        let me = self.clone();
        let (k, changed) = tauri::async_runtime::spawn_blocking(move || secrets::lookup(&me.ks, &me.dir, &me.gate, p))
            .await
            .unwrap_or((None, false));
        if changed {
            self.changed();
        }
        k
    }

    /// R-104: the free set, refreshed by Rust itself (no key) when empty or older than 6 h.
    async fn free_set(self: &Arc<Self>) -> HashSet<String> {
        let fresh = {
            let g = self.lock();
            g.free_openrouter.as_ref().filter(|(at, s)| at.elapsed() < FREE_LIST_MAX_AGE && !s.is_empty()).map(|(_, s)| s.clone())
        };
        if let Some(s) = fresh {
            return s;
        }
        let row = &ENDPOINTS[1];
        let url = url_for(&self.base, &Target { row, path: row.path.to_string() });
        let sent = AtomicBool::new(false);
        if let Ok(r) = send(&self.client, &url, row, None, None, &sent).await {
            if r.status == 200 {
                let ids = free_ids(&r.body);
                self.lock().free_openrouter = Some((Instant::now(), ids.clone()));
                return ids;
            }
        }
        HashSet::new()
    }

    /// `cloud_fetch` without Tauri: gate, table, scope, body, key, free check, send, redact.
    #[allow(clippy::too_many_arguments)]
    pub async fn fetch(
        self: &Arc<Self>,
        label: &str,
        req_id: u32,
        provider: &str,
        method: &str,
        path: &str,
        body: Option<String>,
        scope_ok: &(dyn Fn(&Row) -> bool + Send + Sync),
    ) -> Result<CloudResponse, String> {
        let p = Provider::parse(provider).ok_or("not-allowed")?;
        if self.fail_closed {
            return Err("not-allowed".into());
        }
        self.check_gate(p)?;
        let t = resolve(p, method, path)?;
        if !scope_ok(t.row) {
            return Err("not-allowed".into());
        }
        let (body, model) = rebuild_body(p, t.row.kind, body.as_deref())?;
        // Every row but OpenRouter's public /models needs a key.
        let public = p == Provider::Openrouter && t.row.kind == Kind::List;
        let key = self.key_for(p).await;
        if key.is_none() && !public {
            return Err("no-key".into());
        }
        // R-104's free check runs inside the tracked request below (v2 review): its keyless list
        // fetch is cancelled with the request, and the gate is checked again after it.
        let free_check = p == Provider::Openrouter && t.row.kind == Kind::Chat;
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let sent = Arc::new(AtomicBool::new(false));
        {
            let mut g = self.lock();
            // The gate may have closed while the key was looked up.
            if !g.on {
                return Err("cloud-off".into());
            }
            if !g.enabled.contains(&p) {
                return Err("not-enabled".into());
            }
            if t.row.kind == Kind::Chat {
                spend_call(&mut g.settings.calls, p, utc_day())?;
                let _ = state::save_settings(&self.dir, &g.settings);
            }
            let k = (label.to_string(), req_id);
            if g.inflight.contains_key(&k) {
                return Err("not-allowed".into());
            }
            g.inflight.insert(k, Inflight { provider: p, sent: sent.clone(), cancel: Some(tx) });
        }
        let url = url_for(&self.base, &t);
        let work = async {
            if free_check {
                let m = model.clone().unwrap_or_default();
                if !self.free_set().await.contains(&m) {
                    return Err("not-allowed".to_string());
                }
                self.check_gate(p)?; // turned off while the list was fetched: send nothing
            }
            let mut r = send(&self.client, &url, t.row, key.as_deref(), body, &sent).await?;
            // Gemini's list is paginated: follow nextPageToken up to 5 pages and merge.
            if p == Provider::Gemini && t.row.kind == Kind::List && r.status == 200 {
                let mut all: Value = serde_json::from_str(&r.body).unwrap_or(json!({}));
                for _ in 0..4 {
                    let Some(tok) = all.get("nextPageToken").and_then(Value::as_str).map(str::to_string) else { break };
                    if !page_token_ok(&tok) {
                        break;
                    }
                    let next = send(&self.client, &format!("{url}&pageToken={tok}"), t.row, key.as_deref(), None, &sent).await?;
                    if next.status != 200 {
                        break;
                    }
                    let nv: Value = serde_json::from_str(&next.body).unwrap_or(json!({}));
                    let more = nv.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
                    if let Some(a) = all.get_mut("models").and_then(Value::as_array_mut) {
                        a.extend(more);
                    }
                    match nv.get("nextPageToken") {
                        Some(n) => all["nextPageToken"] = n.clone(),
                        None => {
                            if let Some(o) = all.as_object_mut() {
                                o.remove("nextPageToken");
                            }
                        }
                    }
                }
                r.body = all.to_string();
            }
            Ok::<CloudResponse, String>(r)
        };
        let out = tokio::select! {
            r = work => r,
            _ = rx => Err(if sent.load(Ordering::SeqCst) { "cancelled:sent" } else { "cancelled:unsent" }.to_string()),
        };
        self.lock().inflight.remove(&(label.to_string(), req_id));
        let r = out?;
        if public && r.status == 200 {
            self.lock().free_openrouter = Some((Instant::now(), free_ids(&r.body)));
        }
        Ok(self.redact_reply(r, key.as_deref()))
    }

    /// R-92 step 3: probe with the candidate before storing anything.
    pub async fn probe_key(&self, p: Provider, key: &str) -> KeyCheck {
        let row = match p {
            Provider::Openrouter => &ENDPOINTS[0],
            Provider::Groq => &ENDPOINTS[3],
            Provider::Gemini => &ENDPOINTS[5],
        };
        let url = url_for(&self.base, &Target { row, path: row.path.to_string() });
        let sent = AtomicBool::new(false);
        match send(&self.client, &url, row, Some(key), None, &sent).await {
            Err(_) => KeyCheck::no("unreachable", None),
            Ok(r) if (200..300).contains(&r.status) => KeyCheck { stored: false, status: "ok".into(), store: None, http_status: Some(r.status) },
            Ok(r) if r.status == 401 || r.status == 403 => KeyCheck::no("rejected", Some(r.status)),
            Ok(r) if r.status == 400 && p == Provider::Gemini && r.body.contains("API_KEY_INVALID") => KeyCheck::no("rejected", Some(400)),
            Ok(r) if r.status == 429 => KeyCheck::no("rate-limited", Some(429)),
            Ok(r) => KeyCheck::no("error", Some(r.status)),
        }
    }

    /// "Sign in with OpenRouter": trade the one-time code for a key (src/oauth.rs). One compiled-in
    /// URL, this client (no redirects, no proxy), 30 s. The key is returned to the caller, which
    /// stores it through `secret_set` like a pasted key; it never reaches the page.
    pub async fn openrouter_exchange(&self, code: &str, verifier: &str) -> Result<String, String> {
        self.check_gate(Provider::Openrouter)?;
        let r = self
            .client
            .post(crate::oauth::EXCHANGE_URL)
            .header("Content-Type", "application/json")
            .body(crate::oauth::exchange_body(code, verifier).to_string())
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "unreachable".to_string())?;
        if !r.status().is_success() {
            return Err("exchange-failed".into());
        }
        let mut r = r;
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = r.chunk().await.map_err(|_| "unreachable".to_string())? {
            buf.extend_from_slice(&chunk);
            if buf.len() > 64 * 1024 {
                return Err("exchange-failed".into());
            }
        }
        crate::oauth::key_from_reply(&String::from_utf8_lossy(&buf)).ok_or_else(|| "exchange-failed".to_string())
    }

    /// Before a sign-in opens the browser: is there a keychain to put the key in? A key minted at
    /// OpenRouter and then refused here would stay live on the user's account (security review).
    pub async fn keychain_ready(self: &Arc<Self>) -> Result<(), String> {
        if self.fail_closed {
            return Err("not-allowed".into());
        }
        let me = self.clone();
        let st = tauri::async_runtime::spawn_blocking(move || me.ks.probe()).await.unwrap_or("none");
        self.lock().keystore = st.into();
        match st {
            "keychain" => Ok(()),
            "locked" => Err("locked".into()),
            _ => Err("no-keystore".into()),
        }
    }

    /// `secret_set` (R-92): gate, shape, store choice, probe, then store in one place.
    pub async fn secret_set(
        self: &Arc<Self>,
        provider: &str,
        value: &str,
        store: Option<&str>,
        confirm_file: Box<dyn Fn() -> bool + Send>,
    ) -> Result<KeyCheck, String> {
        let p = Provider::parse(provider).ok_or("not-allowed")?;
        self.check_gate(p)?;
        if self.fail_closed {
            return Err("not-allowed".into());
        }
        let key = secrets::valid_key(value).ok_or("not-allowed")?;
        let choice = Choice::parse(store).ok_or("not-allowed")?;
        // Know the keystore before probing, so a missing one costs the provider no call.
        if self.lock().keystore == "unknown" {
            let me = self.clone();
            let st = tauri::async_runtime::spawn_blocking(move || me.ks.probe()).await.unwrap_or("none");
            self.lock().keystore = st.into();
        }
        let mut ks_state = self.lock().keystore.clone();
        // R-94 [Try again]: a cached "locked" (a dismissed prompt, a locked keyring at boot) is a
        // reason to look again, not to refuse. A keychain still locked fails at the store step
        // and says "locked" again (v2 review).
        if choice == Choice::Keychain && ks_state == "locked" {
            let me = self.clone();
            let st = tauri::async_runtime::spawn_blocking(move || me.ks.probe()).await.unwrap_or("locked");
            self.lock().keystore = st.into();
            ks_state = st.to_string();
        }
        match (choice, ks_state.as_str()) {
            (Choice::Keychain, "none") => return Ok(KeyCheck::no("no-keystore", None)),
            (Choice::Keychain, "locked") => return Ok(KeyCheck::no("locked", None)),
            (Choice::File, s) if s != "none" => return Ok(KeyCheck::no("not-allowed", None)),
            _ => {}
        }
        let check = self.probe_key(p, &key).await;
        if check.status != "ok" {
            return Ok(check);
        }
        self.check_gate(p)?; // turned off while the probe ran: store nothing
        let me = self.clone();
        let r = tauri::async_runtime::spawn_blocking(move || secrets::store(&me.ks, &me.dir, &me.gate, p, &key, choice, &*confirm_file))
            .await
            .map_err(|_| "error".to_string())?;
        self.changed();
        Ok(KeyCheck { http_status: check.http_status, ..r })
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_has_exactly_seven_https_rows() {
        assert_eq!(ENDPOINTS.len(), 7);
        for r in &ENDPOINTS {
            assert!(real_origin(r.provider).starts_with("https://"));
            assert!(!real_origin(r.provider)[8..].contains(':'), "port 443 only");
        }
        assert_eq!(ENDPOINTS.iter().filter(|r| r.query.is_some()).count(), 1);
        assert_eq!(ENDPOINTS[5].query, Some("pageSize=1000"), "the Gemini row appends only pageSize");
    }

    #[test]
    fn paths_are_matched_strictly() {
        let ok = [
            (Provider::Groq, "POST", "/openai/v1/chat/completions"),
            (Provider::Gemini, "POST", "/v1beta/models/gemini-2.5-pro:generateContent"),
            (Provider::Openrouter, "GET", "/api/v1/models"),
        ];
        for (p, m, path) in ok {
            assert!(resolve(p, m, path).is_ok(), "{path}");
        }
        let bad = [
            (Provider::Groq, "GET", "/openai/v1/chat/completions"),
            (Provider::Groq, "POST", "/openai/v1/chat/completions?x=1"),
            (Provider::Groq, "POST", "/openai/v1/chat/completions#f"),
            (Provider::Gemini, "POST", "/v1beta/models/../models/x:generateContent"),
            (Provider::Gemini, "POST", "/v1beta/models/a%2Fb:generateContent"),
            (Provider::Gemini, "POST", "/v1beta/models/a%2eb:generateContent"),
            (Provider::Gemini, "POST", "/v1beta/models//x:generateContent"),
            (Provider::Gemini, "POST", "/v1beta/models/-x:generateContent"),
            (Provider::Gemini, "POST", "/v1beta/models/a/b:generateContent"),
            (Provider::Gemini, "POST", "/v1beta/models/:generateContent"),
            (Provider::Gemini, "GET", "/v1beta/models?pageSize=5"),
            (Provider::Openrouter, "GET", "/api/v1/keys"),
            (Provider::Openrouter, "GET", "api/v1/models"),
            (Provider::Groq, "POST", "/openai/v1/chat/completions\n"),
        ];
        for (p, m, path) in bad {
            assert_eq!(resolve(p, m, path).err(), Some("not-allowed"), "{path:?}");
        }
        let long = format!("/v1beta/models/{}:generateContent", "a".repeat(129));
        assert!(resolve(Provider::Gemini, "POST", &long).is_err());
    }

    #[test]
    fn the_gemini_list_url_gets_its_page_size_from_rust() {
        let t = resolve(Provider::Gemini, "GET", "/v1beta/models").unwrap();
        assert_eq!(url_for(&Base::Real, &t), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
        let t = resolve(Provider::Groq, "POST", "/openai/v1/chat/completions").unwrap();
        assert_eq!(url_for(&Base::Real, &t), "https://api.groq.com/openai/v1/chat/completions");
        assert_eq!(url_for(&Base::Mock(9), &t), "http://127.0.0.1:9/groq/openai/v1/chat/completions");
    }

    #[test]
    fn bodies_are_rebuilt_from_the_allowlist() {
        let page = r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"max_tokens":12000}"#;
        let (b, m) = rebuild_body(Provider::Groq, Kind::Chat, Some(page)).unwrap();
        assert_eq!(m.as_deref(), Some("m"));
        assert_eq!(serde_json::from_str::<Value>(&b.unwrap()).unwrap(), serde_json::from_str::<Value>(page).unwrap());
        for extra in ["models", "plugins", "provider", "route", "transforms", "tools", "stream"] {
            let x = format!(r#"{{"model":"m","messages":[{{"role":"user","content":"hi"}}],"{extra}":[]}}"#);
            assert_eq!(rebuild_body(Provider::Openrouter, Kind::Chat, Some(&x)).err(), Some("not-allowed"), "{extra}");
        }
        let nested = r#"{"model":"m","messages":[{"role":"user","content":"hi","name":"x"}]}"#;
        assert!(rebuild_body(Provider::Groq, Kind::Chat, Some(nested)).is_err());
        let role = r#"{"model":"m","messages":[{"role":"tool","content":"hi"}]}"#;
        assert!(rebuild_body(Provider::Groq, Kind::Chat, Some(role)).is_err());
        let g = r#"{"contents":[{"parts":[{"text":"hi"}]}]}"#;
        assert!(rebuild_body(Provider::Gemini, Kind::Chat, Some(g)).is_ok());
        for bad in [r#"{"contents":[{"parts":[{"text":"hi"}]}],"tools":[{}]}"#, r#"{"contents":[{"parts":[{"text":"hi","inlineData":{}}]}]}"#,
                    r#"{"contents":[{"role":"system","parts":[{"text":"hi"}]}]}"#, r#"{"contents":[]}"#, "not json", "[]"] {
            assert!(rebuild_body(Provider::Gemini, Kind::Chat, Some(bad)).is_err(), "{bad}");
        }
        assert_eq!(rebuild_body(Provider::Groq, Kind::List, Some("x")).err(), Some("not-allowed"), "GET carries no body");
        assert_eq!(rebuild_body(Provider::Groq, Kind::List, None), Ok((None, None)));
        let big = format!(r#"{{"model":"m","messages":[{{"role":"user","content":"{}"}}]}}"#, "x".repeat(MAX_BODY));
        assert_eq!(rebuild_body(Provider::Groq, Kind::Chat, Some(&big)).err(), Some("too-large"));
    }

    #[test]
    fn redaction_covers_the_key_and_its_long_substrings() {
        let k = "test-only-groq-0123456789abcdef";
        assert_eq!(redact(&format!("bad key: {k}."), k), "bad key: [key].");
        assert_eq!(redact("prefix test-only-groq-01 tail", k), "prefix [key] tail");
        assert_eq!(redact("…89abcdef…", k), "…[key]…", "a tail of 8 characters, next to non-ASCII text");
        assert_eq!(redact("short test-on ok", k), "short test-on ok", "7 characters stay");
        assert!(!redact(&format!("{k}{k}"), k).contains("0123"));
    }

    #[test]
    fn free_means_every_price_is_zero() {
        let body = r#"{"data":[
          {"id":"a:free","pricing":{"prompt":"0","completion":"0","request":"0","image":"0","web_search":"0","internal_reasoning":"0"}},
          {"id":"b","pricing":{"prompt":"0","completion":"0.000002"}},
          {"id":"c:free","pricing":{"prompt":"0","completion":"0","request":"0.02"}},
          {"id":"d","pricing":{}},
          {"id":"e"},
          {"id":"f","pricing":{"prompt":0,"completion":0,"new_field":"0"}}]}"#;
        let mut ids: Vec<String> = free_ids(body).into_iter().collect();
        ids.sort();
        assert_eq!(ids, vec!["a:free".to_string(), "f".to_string()]);
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("stagecraft-cloud-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        state::prepare_dir(&d).unwrap();
        d
    }

    #[test]
    fn forget_keeps_the_record_of_a_keychain_key_it_could_not_delete() {
        use crate::secrets::{KsErr, Mode};
        let d = tmp("forget-locked");
        let mut s = state::Settings::default();
        s.cloud_opt_in = true;
        let ks = Keystore::new(Mode::Mock, "t");
        ks.set(Provider::Groq, "test-only-groq-12121212").unwrap();
        let mut g = GateState::new(s, vec![]);
        g.keystore = "keychain".into();
        g.set_stored(Provider::Groq, Some("keychain"));
        state::save_settings(&d, &g.settings).unwrap();
        let c = Cloud::new(g, ks, d.clone(), Base::Real, false, "2");
        *c.ks.inject.lock().unwrap() = Some(KsErr::Locked);
        let st = c.disable(true);
        assert!(!st.on);
        assert_eq!(st.providers["groq"].store.as_deref(), Some("keychain"), "the page learns the key is still there");
        let kept = state::load_settings(&d);
        assert!(!kept.cloud_opt_in, "nothing else survives");
        assert_eq!(kept.providers["groq"].stored.as_deref(), Some("keychain"), "the next boot still offers [Delete them]");
        assert!(kept.providers.get("openrouter").is_none());
        // unlocked: a second forget deletes it and the file
        *c.ks.inject.lock().unwrap() = None;
        let st = c.disable(true);
        assert_eq!(st.providers["groq"].store, None);
        assert!(!d.join(state::SETTINGS).exists());
        assert_eq!(c.ks.get(Provider::Groq), Ok(None));
    }

    #[test]
    fn only_three_response_header_kinds_pass() {
        for (h, keep) in [("content-type", true), ("retry-after", true), ("x-ratelimit-remaining-requests", true),
                          ("set-cookie", false), ("x-mock-extra", false), ("location", false)] {
            assert_eq!(keep_header(h), keep, "{h}");
        }
    }
}

/// A-54 (u), A-64 (u), A-44 (u): Rust against the D-26 mock (`tests/fixtures/mock-cloud.js`),
/// on 127.0.0.1 only. Skipped when `node` is not installed.
#[cfg(test)]
mod mock_tests {
    use super::*;
    use crate::gate::GateState;
    use crate::secrets::Mode;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::process::{Child, Command, Stdio};

    struct Mock {
        child: Child,
        port: u16,
        log: PathBuf,
        dir: PathBuf,
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            let _ = self.child.kill();
        }
    }
    impl Mock {
        fn start(tag: &str) -> Option<Mock> {
            let dir = std::env::temp_dir().join(format!("stagecraft-mockcloud-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            state::prepare_dir(&dir).ok()?;
            let log = dir.join("mock.log");
            let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../idea-walkthrough/tests/fixtures/mock-cloud.js");
            // Tests run in parallel and a freed port can be handed out twice, so wait for THIS
            // mock's own "listening" line; a mock that lost the port exits without one.
            for _ in 0..5 {
                let port = TcpListener::bind("127.0.0.1:0").ok()?.local_addr().ok()?.port();
                let mut child = Command::new("node").arg(script).arg(port.to_string()).env("MOCK_LOG", &log)
                    .stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
                let mut line = String::new();
                let out = child.stdout.take()?;
                let _ = std::io::BufRead::read_line(&mut std::io::BufReader::new(out), &mut line);
                if line.contains("listening") {
                    return Some(Mock { child, port, log, dir });
                }
                let _ = child.kill();
                let _ = child.wait();
            }
            None
        }
        fn mode(&self, provider: &str, mode: &str) {
            let body = format!(r#"{{"provider":"{provider}","mode":"{mode}"}}"#);
            let mut s = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
            write!(s, "POST /__mode HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
        }
        fn lines(&self) -> Vec<Value> {
            std::fs::read_to_string(&self.log).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
        }
        fn cloud(&self, keystore: Mode) -> Arc<Cloud> {
            let mut s = state::Settings::default();
            s.cloud_opt_in = true;
            let mut g = GateState::new(s, vec![]);
            for p in Provider::ALL {
                g.set_enabled(p, true);
            }
            g.session_keys.insert(Provider::Groq, KEY_GROQ.into());
            g.session_keys.insert(Provider::Openrouter, KEY_OR.into());
            g.session_keys.insert(Provider::Gemini, KEY_GEM.into());
            Arc::new(Cloud::new(g, Keystore::new(keystore, "t"), self.dir.clone(), Base::Mock(self.port), false, "2.0.0"))
        }
    }

    const KEY_GROQ: &str = "test-only-groq-00112233445566aa";
    const KEY_OR: &str = "test-only-openrouter-00112233bb";
    const KEY_GEM: &str = "test-only-gemini-00112233445566cc";
    const CHAT: &str = r#"{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hello"}],"max_tokens":12000}"#;
    fn yes(_: &Row) -> bool {
        true
    }
    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn a54_the_wire_carries_exactly_the_listed_headers() {
        let Some(m) = Mock::start("a54") else { return };
        std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:9");
        std::env::set_var("HTTP_PROXY", "http://127.0.0.1:9");
        let c = m.cloud(Mode::Mock);
        let r = run(c.fetch("main", 1, "groq", "POST", "/openai/v1/chat/completions", Some(CHAT.into()), &yes)).unwrap();
        assert_eq!(r.status, 200, "the proxy env vars are ignored");
        let or = CHAT.replace("llama-3.3-70b-versatile", "mock/llama-3.3-70b-instruct:free");
        run(c.fetch("main", 2, "openrouter", "POST", "/api/v1/chat/completions", Some(or), &yes)).unwrap();
        let g = r#"{"contents":[{"parts":[{"text":"hello"}]}]}"#;
        run(c.fetch("main", 3, "gemini", "POST", "/v1beta/models/gemini-2.5-pro:generateContent", Some(g.into()), &yes)).unwrap();
        let chats: Vec<Value> = m.lines().into_iter().filter(|l| l["kind"] == "chat").collect();
        assert_eq!(chats.len(), 3);
        let names = |l: &Value| { let mut v: Vec<String> = l["headers"].as_object().unwrap().keys().cloned().collect(); v.sort(); v };
        let base = ["accept", "content-length", "content-type", "host", "user-agent"];
        let want = |extra: &[&str]| { let mut v: Vec<String> = base.iter().chain(extra).map(|s| s.to_string()).collect(); v.sort(); v };
        assert_eq!(names(&chats[0]), want(&["authorization"]));
        assert!(chats[0]["headers"]["authorization"].as_str().unwrap().starts_with("Bearer sha256:"), "the mock never logs a key");
        assert_eq!(chats[0]["keyKind"], "test-key:groq");
        assert!(!std::fs::read_to_string(&m.log).unwrap().contains("test-only-"), "no key value in the mock log");
        assert_eq!(chats[0]["headers"]["user-agent"], "Stagecraft/2.0.0");
        assert_eq!(chats[0]["headers"]["accept"], "*/*");
        assert_eq!(names(&chats[1]), want(&["authorization", "x-title"]));
        assert_eq!(names(&chats[2]), want(&["x-goog-api-key"]));
        assert!(chats[2]["headers"]["x-goog-api-key"].as_str().unwrap().starts_with("sha256:"));
        assert_eq!(chats[2]["keyKind"], "test-key:gemini");
        let _ = KEY_GEM;
        std::env::remove_var("HTTPS_PROXY");
        std::env::remove_var("HTTP_PROXY");
        // reply headers: only content-type, retry-after and x-ratelimit-*
        assert!(r.headers.iter().all(|(n, _)| keep_header(n)) && r.headers.iter().any(|(n, _)| n == "x-ratelimit-remaining-requests"));
    }

    #[test]
    fn a54_redirects_size_and_bodies() {
        let Some(m) = Mock::start("a54b") else { return };
        let c = m.cloud(Mode::Mock);
        m.mode("groq", "redirect");
        let r = run(c.fetch("main", 1, "groq", "GET", "/openai/v1/models", None, &yes)).unwrap();
        assert_eq!(r.status, 302, "a 302 is returned, not followed");
        m.mode("groq", "huge");
        assert_eq!(run(c.fetch("main", 2, "groq", "GET", "/openai/v1/models", None, &yes)).err().as_deref(), Some("reply-too-large:200"),
                   "an oversized REPLY is its own, delivered code; too-large is the request's");
        assert_eq!(run(c.fetch("main", 6, "groq", "POST", "/openai/v1/chat/completions", Some(CHAT.into()), &yes)).err().as_deref(), Some("reply-too-large:200"));
        assert!(m.lines().iter().any(|l| l["kind"] == "chat" && l["status"] == 200), "the provider saw and answered the chat");
        m.mode("groq", "reset");
        assert_eq!(run(c.fetch("main", 7, "groq", "POST", "/openai/v1/chat/completions", Some(CHAT.into()), &yes)).err().as_deref(), Some("interrupted:200"),
                   "a body cut off after the status is delivered, not unreachable");
        m.mode("groq", "ok");
        let before = m.lines().len();
        for extra in ["models", "plugins", "provider", "transforms"] {
            let b = format!(r#"{{"model":"mock/llama-3.3-70b-instruct:free","messages":[{{"role":"user","content":"x"}}],"{extra}":["a"]}}"#);
            assert_eq!(run(c.fetch("main", 3, "openrouter", "POST", "/api/v1/chat/completions", Some(b), &yes)).err().as_deref(), Some("not-allowed"));
        }
        let tools = r#"{"contents":[{"parts":[{"text":"x"}]}],"tools":[{"googleSearch":{}}]}"#;
        assert_eq!(run(c.fetch("main", 4, "gemini", "POST", "/v1beta/models/gemini-2.5-pro:generateContent", Some(tools.into()), &yes)).err().as_deref(), Some("not-allowed"));
        assert_eq!(m.lines().len(), before, "a refused body sends nothing");
        assert!(!m.lines().iter().any(|l| l["path"].as_str().unwrap_or("").contains("elsewhere")));
        // the scope must match too
        assert_eq!(run(c.fetch("main", 5, "groq", "GET", "/openai/v1/models", None, &|_| false)).err().as_deref(), Some("not-allowed"));
    }

    #[test]
    fn a64_openrouter_chats_only_on_fully_free_models() {
        let Some(m) = Mock::start("a64") else { return };
        let c = m.cloud(Mode::Mock);
        for paid in ["mock/llama-3.1-405b-instruct", "mock/hermes-3-8b-request:free"] {
            let b = CHAT.replace("llama-3.3-70b-versatile", paid);
            assert_eq!(run(c.fetch("main", 1, "openrouter", "POST", "/api/v1/chat/completions", Some(b), &yes)).err().as_deref(), Some("not-allowed"), "{paid}");
        }
        let lines = m.lines();
        assert!(!lines.iter().any(|l| l["kind"] == "chat"), "no chat request for a paid model");
        let fetched: Vec<&Value> = lines.iter().filter(|l| l["path"] == "/openrouter/api/v1/models").collect();
        assert!(!fetched.is_empty() && fetched.iter().all(|l| l["headers"].get("authorization").is_none()), "Rust fetched the public list itself, with no key");
        let b = CHAT.replace("llama-3.3-70b-versatile", "mock/llama-3.3-70b-instruct:free");
        assert_eq!(run(c.fetch("main", 2, "openrouter", "POST", "/api/v1/chat/completions", Some(b), &yes)).unwrap().status, 200);
    }

    #[test]
    fn r105_an_echoed_key_comes_back_redacted() {
        let Some(m) = Mock::start("r105") else { return };
        let c = m.cloud(Mode::Mock);
        m.mode("groq", "echo-key");
        let r = run(c.fetch("main", 1, "groq", "GET", "/openai/v1/models", None, &yes)).unwrap();
        assert_eq!(r.status, 401);
        assert!(r.body.contains("[key]") && !r.body.contains("test-only-"), "{}", r.body);
    }

    #[test]
    fn a65_a_cancel_aborts_the_request_and_says_it_was_sent() {
        let Some(m) = Mock::start("a65") else { return };
        let c = m.cloud(Mode::Mock);
        m.mode("groq", "slow");
        let c2 = c.clone();
        let h = std::thread::spawn(move || run(c2.fetch("main", 7, "groq", "POST", "/openai/v1/chat/completions", Some(CHAT.into()), &yes)));
        for _ in 0..100 {
            if m.lines().iter().any(|l| l["kind"] == "chat") {
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        assert!(!c.cancel("main-2", 7), "another window cannot cancel it");
        let st = c.disable(false);
        assert!(!st.on && !st.providers["groq"].enabled);
        assert_eq!(h.join().unwrap().err().as_deref(), Some("cancelled:sent"));
        std::thread::sleep(Duration::from_millis(300));
        assert!(m.lines().iter().any(|l| l["aborted"] == true), "the mock saw the connection close");
        assert_eq!(run(c.fetch("main", 8, "groq", "GET", "/openai/v1/models", None, &yes)).err().as_deref(), Some("cloud-off"));
        assert!(c.lock().session_keys.contains_key(&Provider::Groq), "session keys survive opt-out (R-93)");
        assert!(c.lock().keys.is_empty());
    }

    #[test]
    fn gate_refusals_come_before_any_request() {
        let Some(m) = Mock::start("gate") else { return };
        let c = m.cloud(Mode::Mock);
        c.provider_set(Provider::Gemini, false).unwrap();
        assert_eq!(run(c.fetch("main", 1, "gemini", "GET", "/v1beta/models", None, &yes)).err().as_deref(), Some("not-enabled"));
        c.lock().session_keys.remove(&Provider::Groq);
        assert_eq!(run(c.fetch("main", 2, "groq", "GET", "/openai/v1/models", None, &yes)).err().as_deref(), Some("no-key"));
        assert_eq!(run(c.fetch("main", 3, "openai", "GET", "/v1/models", None, &yes)).err().as_deref(), Some("not-allowed"));
        assert!(m.lines().is_empty(), "nothing reached the mock");
        let fc = Arc::new(Cloud::new(GateState::new(state::Settings::default(), vec![]), Keystore::new(Mode::Mock, "t"), m.dir.clone(), Base::Mock(m.port), true, "2"));
        assert_eq!(run(fc.fetch("main", 1, "groq", "GET", "/openai/v1/models", None, &yes)).err().as_deref(), Some("not-allowed"), "fail closed");
    }

    #[test]
    fn gemini_lists_are_merged_across_pages() {
        let Some(m) = Mock::start("gem") else { return };
        let c = m.cloud(Mode::Mock);
        let r = run(c.fetch("main", 1, "gemini", "GET", "/v1beta/models", None, &yes)).unwrap();
        let v: Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(v["models"].as_array().unwrap().len(), 4);
        assert!(v.get("nextPageToken").is_none());
        let paths: Vec<String> = m.lines().iter().map(|l| l["path"].as_str().unwrap().to_string()).collect();
        assert_eq!(paths, vec!["/gemini/v1beta/models?pageSize=1000", "/gemini/v1beta/models?pageSize=1000&pageToken=page-2"]);
    }

    #[test]
    fn a_connect_failure_is_unreachable_and_never_counted() {
        // nothing listens on this port: is_connect, so unreachable (not timeout, which counts)
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let c = client("2");
        let sent = AtomicBool::new(false);
        let r = run(send(&c, &format!("http://127.0.0.1:{port}/groq/openai/v1/models"), &ENDPOINTS[3], None, None, &sent));
        assert_eq!(r.err().as_deref(), Some("unreachable"));
    }

    #[test]
    fn r104_the_free_list_fetch_is_tracked_and_cancelled_with_its_chat() {
        let Some(m) = Mock::start("r104c") else { return };
        let c = m.cloud(Mode::Mock);
        m.mode("openrouter", "slow"); // the keyless /models fetch hangs
        let c2 = c.clone();
        let b = CHAT.replace("llama-3.3-70b-versatile", "mock/llama-3.3-70b-instruct:free");
        let t0 = Instant::now();
        let h = std::thread::spawn(move || run(c2.fetch("main", 9, "openrouter", "POST", "/api/v1/chat/completions", Some(b), &yes)));
        for _ in 0..200 {
            if m.lines().iter().any(|l| l["path"] == "/openrouter/api/v1/models") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(c.lock().inflight.len(), 1, "the list fetch runs under the chat's cancel token");
        c.disable(false);
        assert_eq!(h.join().unwrap().err().as_deref(), Some("cancelled:unsent"));
        assert!(t0.elapsed() < Duration::from_secs(10), "it stopped at once, not after the slow reply");
        std::thread::sleep(Duration::from_millis(300));
        assert!(m.lines().iter().any(|l| l["aborted"] == true), "the /models request itself was aborted");
        assert!(!m.lines().iter().any(|l| l["kind"] == "chat"), "no chat was sent");
    }

    #[test]
    fn d4_a_replaced_window_cancels_its_requests_and_reports_sent_ones() {
        let Some(m) = Mock::start("d4") else { return };
        let c = m.cloud(Mode::Mock);
        m.mode("groq", "slow");
        let c2 = c.clone();
        let h = std::thread::spawn(move || run(c2.fetch("main", 3, "groq", "POST", "/openai/v1/chat/completions", Some(CHAT.into()), &yes)));
        for _ in 0..200 {
            if m.lines().iter().any(|l| l["kind"] == "chat") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(c.cancel_label("main-2"), 0, "another window's label cancels nothing");
        assert_eq!(c.cancel_label("main"), 1);
        assert_eq!(h.join().unwrap().err().as_deref(), Some("cancelled:sent"));
        assert_eq!(c.lock().unrecorded.get("groq"), Some(&1), "the sent request is kept for the next page's ledger");
    }

    #[test]
    fn r94_try_again_after_a_locked_keychain_looks_again() {
        use crate::secrets::KsErr;
        let Some(m) = Mock::start("r94") else { return };
        let c = m.cloud(Mode::Mock);
        c.lock().session_keys.clear();
        c.lock().keystore = "keychain".into();
        *c.ks.inject.lock().unwrap() = Some(KsErr::Locked); // the unlock prompt was dismissed
        let set = || run(c.secret_set("groq", "test-only-groq-r94r94r94", Some("keychain"), Box::new(|| panic!("no dialog")))).unwrap();
        assert_eq!(set().status, "locked");
        assert_eq!(c.lock().keystore, "locked");
        assert_eq!(set().status, "locked", "still locked: still locked");
        *c.ks.inject.lock().unwrap() = None; // the user unlocks the keyring
        let r = set();
        assert_eq!((r.stored, r.status.as_str(), r.store.as_deref()), (true, "ok", Some("keychain")), "[Try again] now works");
        assert_eq!(c.lock().keystore, "keychain");
        assert_eq!(c.ks.get(Provider::Groq).unwrap().as_deref(), Some("test-only-groq-r94r94r94"));
    }

    #[test]
    fn a44_secret_set_probes_before_it_stores() {
        let Some(m) = Mock::start("a44") else { return };
        let c = m.cloud(Mode::Mock);
        c.lock().session_keys.clear();
        let set = |p: &str| run(c.secret_set(p, "test-only-candidate-0011223344", None, Box::new(|| panic!("no dialog")))).unwrap();
        for (p, mode, status, http) in [("groq", "401", "rejected", Some(401)), ("openrouter", "403", "rejected", Some(403)),
                                        ("gemini", "400-invalid-key", "rejected", Some(400)), ("groq", "500", "error", Some(500)),
                                        ("groq", "429", "rate-limited", Some(429))] {
            m.mode(p, mode);
            let r = set(p);
            assert_eq!((r.stored, r.status.as_str(), r.http_status), (false, status, http), "{p} {mode}");
            assert!(!secrets::has(&c.gate, Provider::parse(p).unwrap()).present);
            m.mode(p, "ok");
        }
        let r = set("groq");
        assert_eq!((r.stored, r.status.as_str(), r.store.as_deref()), (true, "ok", Some("keychain")));
        assert!(secrets::has(&c.gate, Provider::Groq).present);
        let probes: Vec<Value> = m.lines().into_iter().filter(|l| l["provider"] == "openrouter").collect();
        assert_eq!(probes[0]["path"], "/openrouter/api/v1/key", "OpenRouter's key is checked on /key, not the public list");
        // the mock is gone: unreachable, nothing stored
        let port = m.port;
        drop(m);
        let c2 = Arc::new(Cloud::new(GateState::new({ let mut s = state::Settings::default(); s.cloud_opt_in = true; s }, vec![]),
                                     Keystore::new(Mode::Mock, "t"), std::env::temp_dir(), Base::Mock(port), false, "2"));
        c2.lock().set_enabled(Provider::Groq, true);
        let r = run(c2.secret_set("groq", "test-only-candidate-0011223344", None, Box::new(|| false))).unwrap();
        assert_eq!((r.stored, r.status.as_str()), (false, "unreachable"));
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn the_daily_ceiling_holds_and_resets_with_the_day() {
        let mut calls = std::collections::BTreeMap::new();
        for _ in 0..daily_ceiling(Provider::Gemini) {
            assert!(spend_call(&mut calls, Provider::Gemini, 100).is_ok());
        }
        assert_eq!(spend_call(&mut calls, Provider::Gemini, 100), Err("budget".to_string()));
        assert!(spend_call(&mut calls, Provider::Groq, 100).is_ok(), "per provider");
        assert!(spend_call(&mut calls, Provider::Gemini, 101).is_ok(), "a new UTC day starts again");
        assert_eq!(calls["gemini"], (101, 1));
    }
    #[test]
    fn ceilings_sit_at_or_above_the_free_allowances() {
        assert!(daily_ceiling(Provider::Openrouter) >= 1000);
        assert!(daily_ceiling(Provider::Groq) >= 1000);
        assert!(daily_ceiling(Provider::Gemini) >= 250);
    }
}
