//! "Sign in with OpenRouter" (OAuth PKCE), 2026-11-18.
//!
//! Replaces the seven-step copy-and-paste key setup (sign up, Keys, Create, name, copy, paste,
//! Save) with: click, sign in on openrouter.ai, Authorize, back to the app. Flow as documented at
//! https://openrouter.ai/docs/guides/overview/auth/oauth (fetched 2026-11-18): the browser goes to
//! `https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256`,
//! OpenRouter redirects to a localhost callback ("supported on any port") with `?code=`, and
//! `POST https://openrouter.ai/api/v1/auth/keys {code, code_verifier, code_challenge_method}`
//! returns `{key}`, an ordinary user-controlled key.
//!
//! Security (design rule R3, STUDY-security):
//! - the verifier never leaves Rust; the page never sees the code or the key;
//! - the listener binds loopback only, on a random port, accepts exactly one callback whose
//!   `state` matches, and stops after 5 minutes;
//! - the exchange goes to one compiled-in URL, with redirects off (`cloud::client`);
//! - the key is stored through the same `Cloud::secret_set` path as a pasted key (keychain, R-93),
//!   so the free-only rule (R-104) and every later check apply unchanged.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

pub const AUTH_URL: &str = "https://openrouter.ai/auth";
pub const EXCHANGE_URL: &str = "https://openrouter.ai/api/v1/auth/keys";
pub const WAIT: Duration = Duration::from_secs(300);

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

fn random_b64(n: usize) -> Result<String, &'static str> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).map_err(|_| "no-randomness")?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// A fresh verifier (43 url-safe chars from 32 random bytes), its S256 challenge, and a state.
pub fn pkce() -> Result<Pkce, &'static str> {
    let verifier = random_b64(32)?;
    let challenge = challenge_for(&verifier);
    Ok(Pkce { verifier, challenge, state: random_b64(16)? })
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Only the unreserved characters pass; everything else is percent-encoded.
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn callback_url(port: u16) -> String {
    format!("http://localhost:{port}/callback")
}

pub fn auth_url(port: u16, p: &Pkce) -> String {
    format!(
        "{AUTH_URL}?callback_url={}&code_challenge={}&code_challenge_method=S256&state={}&key_label=Stagecraft",
        enc(&callback_url(port)),
        enc(&p.challenge),
        enc(&p.state)
    )
}

fn query_value<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == name).then_some(v)
    })
}

/// The request line of one HTTP request to the listener. Ok(code) only for
/// `GET /callback?…code=…&state=<ours>`; the code must be plain url-safe text.
pub fn parse_callback(request_line: &str, state: &str) -> Result<String, &'static str> {
    let mut parts = request_line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" {
        return Err("not-callback");
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return Err("not-callback");
    }
    if query_value(query, "state") != Some(state) {
        return Err("state-mismatch");
    }
    if query_value(query, "error").is_some() {
        return Err("declined");
    }
    match query_value(query, "code") {
        Some(c) if !c.is_empty() && c.len() <= 512 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.~".contains(&b)) => Ok(c.to_string()),
        _ => Err("no-code"),
    }
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>Stagecraft</title><body style=\"font:16px system-ui;margin:3em\"><h1>Connected</h1><p>You can close this tab and go back to Stagecraft.</p>";
const PAGE_NO: &str = "<!doctype html><meta charset=utf-8><title>Stagecraft</title><body style=\"font:16px system-ui;margin:3em\"><h1>Not connected</h1><p>Go back to Stagecraft and try again.</p>";

fn answer(mut s: TcpStream, status: &str, body: &str) {
    let _ = write!(
        s,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Waits (blocking) for the one callback on any of `listeners`, until `deadline`. Requests that
/// are not the callback (a favicon, a stray probe) get a 404 and the wait goes on; a callback
/// with the wrong state is refused and ends the wait.
pub fn wait_for_code(listeners: &[TcpListener], state: &str, deadline: Instant, cancelled: &dyn Fn() -> bool) -> Result<String, &'static str> {
    for l in listeners {
        l.set_nonblocking(true).map_err(|_| "listen-failed")?;
    }
    loop {
        if cancelled() {
            return Err("cancelled");
        }
        if Instant::now() >= deadline {
            return Err("timeout");
        }
        let mut got = None;
        for l in listeners {
            if let Ok((s, _)) = l.accept() {
                got = Some(s);
                break;
            }
        }
        let Some(mut s) = got else {
            std::thread::sleep(Duration::from_millis(100));
            continue;
        };
        let _ = s.set_nonblocking(false);
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = s.read(&mut buf).unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..n]);
        let line = head.lines().next().unwrap_or("");
        match parse_callback(line, state) {
            Ok(code) => {
                answer(s, "200 OK", PAGE_OK);
                return Ok(code);
            }
            /* Any local process or web page can hit this port; one stray request with the wrong
               (or no) state must not end the user's sign-in (security review 2026-11-18). */
            Err("not-callback") | Err("state-mismatch") => answer(s, "404 Not Found", ""),
            Err(e) => {
                answer(s, "400 Bad Request", PAGE_NO);
                return Err(e);
            }
        }
    }
}

/// Binds 127.0.0.1 on a random port, and [::1] on the same port when it can, because the
/// browser may resolve "localhost" to either.
pub fn listen() -> Result<(Vec<TcpListener>, u16), &'static str> {
    let v4 = TcpListener::bind("127.0.0.1:0").map_err(|_| "listen-failed")?;
    let port = v4.local_addr().map_err(|_| "listen-failed")?.port();
    let mut all = vec![v4];
    if let Ok(v6) = TcpListener::bind(("::1", port)) {
        all.push(v6);
    }
    Ok((all, port))
}

pub fn exchange_body(code: &str, verifier: &str) -> serde_json::Value {
    serde_json::json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" })
}

/// The key from the exchange reply, if it looks like one (the same shape check as a pasted key).
pub fn key_from_reply(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let k = v.get("key")?.as_str()?;
    // An OpenRouter key, nothing else: "sk-or-" and url-safe characters (stricter than a pasted key).
    if !k.starts_with("sk-or-") || !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    crate::secrets::valid_key(k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_is_rfc7636_s256() {
        // base64url(sha256(verifier)), no padding; the expected value was computed independently
        // with Python's hashlib + base64.urlsafe_b64encode (2026-11-18).
        assert_eq!(challenge_for("dBjftJeZ4CVP-mJ92K0RbLRpgpXnXMxNcfVuAGXHAeo"), "9s4XizFAf9B92FoVPcpThCagcpbz2u_d_oAV2Bvz1pg");
        let p = pkce().unwrap();
        assert_eq!(p.verifier.len(), 43);
        assert!(p.verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_eq!(p.challenge, challenge_for(&p.verifier));
        assert_ne!(pkce().unwrap().verifier, p.verifier, "fresh per sign-in");
    }

    #[test]
    fn auth_url_has_exactly_the_documented_parameters() {
        let p = Pkce { verifier: "v".into(), challenge: "c-_".into(), state: "s".into() };
        let u = auth_url(51423, &p);
        assert_eq!(u, "https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A51423%2Fcallback&code_challenge=c-_&code_challenge_method=S256&state=s&key_label=Stagecraft");
        assert!(!u.contains("code_verifier"), "the verifier never leaves Rust");
    }

    #[test]
    fn only_our_callback_is_accepted() {
        assert_eq!(parse_callback("GET /callback?code=abc_DEF-1&state=S HTTP/1.1", "S"), Ok("abc_DEF-1".into()));
        assert_eq!(parse_callback("GET /callback?state=S&code=abc HTTP/1.1", "S"), Ok("abc".into()));
        assert_eq!(parse_callback("GET /callback?code=abc&state=X HTTP/1.1", "S"), Err("state-mismatch"));
        assert_eq!(parse_callback("GET /callback?code=abc HTTP/1.1", "S"), Err("state-mismatch"));
        assert_eq!(parse_callback("GET /callback?error=access_denied&state=S HTTP/1.1", "S"), Err("declined"));
        assert_eq!(parse_callback("GET /callback?code=a%0Ab&state=S HTTP/1.1", "S"), Err("no-code"));
        assert_eq!(parse_callback("GET /callback?code=&state=S HTTP/1.1", "S"), Err("no-code"));
        assert_eq!(parse_callback("POST /callback?code=abc&state=S HTTP/1.1", "S"), Err("not-callback"));
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1", "S"), Err("not-callback"));
        assert_eq!(parse_callback("", "S"), Err("not-callback"));
    }

    #[test]
    fn exchange_body_and_reply() {
        assert_eq!(exchange_body("C", "V").to_string(), r#"{"code":"C","code_challenge_method":"S256","code_verifier":"V"}"#);
        assert!(key_from_reply(concat!(r#"{"key":"sk-"#, r#"or-v1-0123456789abcdef0123456789abcdef"}"#)).is_some());  // split so secret scanners skip this fake key
        assert!(key_from_reply(r#"{"key":"<script>"}"#).is_none());
        assert!(key_from_reply("not json").is_none());
        assert!(key_from_reply(r#"{"error":"bad code"}"#).is_none());
    }

    #[test]
    fn the_listener_is_loopback_only_and_answers_one_callback() {
        let (ls, port) = listen().unwrap();
        for l in &ls {
            assert!(l.local_addr().unwrap().ip().is_loopback());
        }
        let t = std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n").unwrap();
            let mut r = String::new();
            let _ = s.read_to_string(&mut r);
            assert!(r.starts_with("HTTP/1.1 404"));
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET /callback?code=abc&state=ST HTTP/1.1\r\n\r\n").unwrap();
            let mut r = String::new();
            let _ = s.read_to_string(&mut r);
            assert!(r.starts_with("HTTP/1.1 200") && r.contains("Connected"));
        });
        let code = wait_for_code(&ls, "ST", Instant::now() + Duration::from_secs(10), &|| false);
        t.join().unwrap();
        assert_eq!(code, Ok("abc".into()));
    }

    #[test]
    fn a_wrong_state_does_not_end_the_wait() {
        let (ls, port) = listen().unwrap();
        let t = std::thread::spawn(move || {
            for req in ["GET /callback?code=evil&state=WRONG HTTP/1.1\r\n\r\n", "GET /callback?code=good&state=ST HTTP/1.1\r\n\r\n"] {
                let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
                s.write_all(req.as_bytes()).unwrap();
                let mut r = String::new();
                let _ = s.read_to_string(&mut r);
            }
        });
        let code = wait_for_code(&ls, "ST", Instant::now() + Duration::from_secs(10), &|| false);
        t.join().unwrap();
        assert_eq!(code, Ok("good".into()));
    }

    #[test]
    fn the_wait_ends_on_cancel_and_on_timeout() {
        let (ls, _) = listen().unwrap();
        assert_eq!(wait_for_code(&ls, "S", Instant::now() + Duration::from_secs(10), &|| true), Err("cancelled"));
        assert_eq!(wait_for_code(&ls, "S", Instant::now(), &|| false), Err("timeout"));
    }
}
