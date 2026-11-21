//! The self-test harness (DESIGN §9, A-5). Set `STAGECRAFT_SELFTEST=<report path>` and the app
//! starts normally, the page runs its own detection (and optionally a chat, a stage or an
//! action) through the SAME code the app uses, writes a JSON report through `selftest_report`,
//! and exits 0. A watchdog writes `{"timeout":true}` and exits 2 if the page never reports.
//!
//! The env vars act only through the runtime `selftest` capability (R-80): without
//! `STAGECRAFT_SELFTEST` that capability is never added, so `selftest_report` is not callable.

use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct Spec {
    #[serde(skip)]
    pub report: PathBuf,
    pub chat: bool,
    pub stage: Option<String>,
    pub action: Option<String>,
    pub dialog: Option<String>,
    /// Debug builds only: the echo server base for A-6b.
    pub echo: Option<String>,
    /// v2, debug builds only (D-29): how the harness answers each R-98 send panel.
    pub disclose: Option<String>,
    /// v2, debug builds only: whether the D-26 mock provider is in use (the page never learns
    /// its port; Rust rewrites the origins).
    pub mock: bool,
    /// v2, debug builds only: earlier outputs seeded before a single stage runs
    /// (`tests/fixtures/seed-outputs.json`).
    pub seed: Option<serde_json::Value>,
    /// True only in a debug build. The page runs its v2 (D-29) block only when this is set.
    pub debug: bool,
}

/// What a release build's self-test may do: v1's set only (DESIGN §9). D-29: every v2 value
/// and action is debug-only, so a release binary given `…_ACTION=delete-keys` or
/// `…_STAGE=all` does neither (v2 review).
#[cfg_attr(debug_assertions, allow(dead_code))]
fn release_filter(stage: Option<String>, action: Option<String>) -> (Option<String>, Option<String>) {
    let stage = stage.filter(|s| s == "capture");
    let action = action.filter(|a| matches!(a.as_str(), "forget" | "export" | "reload" | "abort"));
    (stage, action)
}

/// Debug builds only: the mock's port, when `…_MOCKCLOUD` is a usable port. `Err` when it is set
/// but unusable, which fails closed.
#[cfg(debug_assertions)]
fn mock_port() -> Option<Result<u16, ()>> {
    var("STAGECRAFT_SELFTEST_MOCKCLOUD").map(|p| p.parse::<u16>().ok().filter(|p| *p != 0).ok_or(()))
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

impl Spec {
    pub fn from_env() -> Option<Spec> {
        let report = PathBuf::from(var("STAGECRAFT_SELFTEST")?);
        let echo = if cfg!(debug_assertions) && var("STAGECRAFT_SELFTEST_ECHO").as_deref() == Some("1") {
            Some("http://127.0.0.1:11435".to_string())
        } else {
            None
        };
        let stage = var("STAGECRAFT_SELFTEST_STAGE");
        let action = var("STAGECRAFT_SELFTEST_ACTION");
        #[cfg(not(debug_assertions))]
        let (stage, action) = release_filter(stage, action);
        // `mock` comes from the same parsed port cloud_base() uses (v2 review).
        #[cfg(debug_assertions)]
        let (disclose, mock) = (var("STAGECRAFT_SELFTEST_DISCLOSE"), matches!(mock_port(), Some(Ok(_))));
        #[cfg(debug_assertions)]
        let seed = stage
            .as_deref()
            .filter(|s| !matches!(*s, "capture" | "all"))
            .and_then(|_| serde_json::from_str(include_str!("../../../idea-walkthrough/tests/fixtures/seed-outputs.json")).ok());
        #[cfg(not(debug_assertions))]
        let (disclose, mock, seed) = (None, false, None);
        Some(Spec {
            report,
            chat: var("STAGECRAFT_SELFTEST_CHAT").as_deref() == Some("1"),
            stage,
            action,
            dialog: var("STAGECRAFT_SELFTEST_DIALOG"),
            echo,
            disclose,
            mock,
            seed,
            debug: cfg!(debug_assertions),
        })
    }

    /// 90 s by default; a full stage on CPU can take many minutes, so 30 min with a stage.
    pub fn watchdog(&self) -> Duration {
        if self.stage.is_some() {
            Duration::from_secs(30 * 60)
        } else if self.chat || self.action.as_deref() == Some("abort") {
            Duration::from_secs(10 * 60)
        } else {
            Duration::from_secs(90)
        }
    }
}

/// Debug builds only: point the page's Ollama base elsewhere (A-7, a closed port). Release
/// builds ignore it, so a stray env var can never redirect a user's app.
pub fn ollama_override() -> Option<String> {
    if cfg!(debug_assertions) {
        var("STAGECRAFT_SELFTEST_OLLAMA")
    } else {
        None
    }
}

/// v2 (D-26): where cloud requests go, and whether they must all be refused. A release build
/// always talks to the real providers and never reads these variables (A-63: their names are
/// not even in the binary). A debug build fails closed (refuses every cloud request) when:
/// - test keys or a test keystore are given without the mock, so a test key never reaches a
///   real host;
/// - any self-test runs without the mock (v2 review: an `a41` that opts in during the run must
///   not reach the real internet either);
/// - `…_MOCKCLOUD` is set but is not a usable port;
/// - the mock is used without an explicit `STAGECRAFT_DATA_DIR`, so a mock run never reads the
///   user's real data directory (and, with it, a real keychain record).
pub fn cloud_base() -> (crate::cloud::Base, bool) {
    #[cfg(debug_assertions)]
    {
        match mock_port() {
            Some(Ok(port)) => {
                let explicit_dir = std::env::var_os("STAGECRAFT_DATA_DIR").is_some_and(|d| !d.is_empty());
                return (crate::cloud::Base::Mock(port), !explicit_dir);
            }
            Some(Err(())) => return (crate::cloud::Base::Real, true),
            None => {}
        }
        let test_creds = var("STAGECRAFT_SELFTEST_KEYSTORE").is_some() || var("STAGECRAFT_SELFTEST_KEYS").is_some();
        return (crate::cloud::Base::Real, test_creds || var("STAGECRAFT_SELFTEST").is_some());
    }
    #[allow(unreachable_code)]
    (crate::cloud::Base::Real, false)
}

/// D-29, debug builds only: the IPC log A-40 greps.
pub fn ipclog_path() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        return var("STAGECRAFT_SELFTEST_IPCLOG").map(PathBuf::from);
    }
    #[allow(unreachable_code)]
    None
}

pub fn start_watchdog(spec: &Spec) {
    let report = spec.report.clone();
    let after = spec.watchdog();
    std::thread::spawn(move || {
        std::thread::sleep(after);
        let _ = std::fs::write(&report, br#"{"timeout":true}"#);
        eprintln!("stagecraft selftest: watchdog fired after {}s", after.as_secs());
        std::process::exit(2);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watchdog_lengths() {
        let mut s = Spec { report: "/tmp/x".into(), chat: false, stage: None, action: None, dialog: None, echo: None, disclose: None, mock: false, seed: None, debug: true };
        assert_eq!(s.watchdog().as_secs(), 90);
        s.stage = Some("capture".into());
        assert_eq!(s.watchdog().as_secs(), 1800);
    }

    #[test]
    fn a_release_spec_keeps_only_v1_values() {
        let f = |st: Option<&str>, a: Option<&str>| release_filter(st.map(str::to_string), a.map(str::to_string));
        assert_eq!(f(Some("capture"), Some("forget")), (Some("capture".into()), Some("forget".into())));
        for a in ["export", "reload", "abort"] {
            assert_eq!(f(None, Some(a)).1.as_deref(), Some(a));
        }
        for a in ["delete-keys", "opt-in", "a41", "a64", "fork", "unfork", "keep-local", "cloud-off-midcall", "forget,delete-keys", "export,fork"] {
            assert_eq!(f(None, Some(a)).1, None, "{a}");
        }
        for st in ["all", "critique", "deepen"] {
            assert_eq!(f(Some(st), None).0, None, "{st}");
        }
    }

    #[test]
    fn spec_serialises_without_the_report_path() {
        let s = Spec { report: "/secret/path".into(), chat: true, stage: None, action: Some("export".into()), dialog: Some("cancel".into()), echo: None, disclose: None, mock: false, seed: None, debug: true };
        let j = serde_json::to_string(&s).unwrap();
        assert!(!j.contains("/secret/path"));
        assert!(j.contains(r#""chat":true"#) && j.contains(r#""action":"export""#));
    }
}
