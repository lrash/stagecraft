//! The desktop record: `state.json` in the app's data directory (DESIGN D-12, R-36..R-38, R-75).
//!
//! One writer, atomic replace, and a `.bak` that is only ever a copy of a file that parsed:
//! - the data directory is 0700, every file is CREATED 0600 (never chmodded after the fact);
//! - a save writes `state.json.tmp`, fsyncs it, renames it over `state.json`, fsyncs the dir;
//! - before that, the current `state.json` is copied to `.bak` only if it parses, so a corrupt
//!   file can never overwrite the last good backup;
//! - at load, an unparseable `state.json` is renamed to `.bad` and `.bak` is loaded instead.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const STATE: &str = "state.json";
pub const BAK: &str = "state.json.bak";
pub const BAD: &str = "state.json.bad";
pub const TMP: &str = "state.json.tmp";
pub const PROBE: &str = ".probe";
/// A state file larger than this is refused rather than written (DESIGN `state_save`).
pub const MAX_BYTES: usize = 20 * 1024 * 1024;

/// What startup found on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub state: Option<String>,
    /// `None`, `"restored-from-bak"` or `"unreadable"`.
    pub error: Option<&'static str>,
}

/// Creates the data directory if needed and makes it private to the user (0700).
pub fn prepare_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    // Drop every group/other bit; keep what the owner has. A directory the user made read-only
    // stays read-only, so the canary below can report it honestly (A-12).
    #[cfg(unix)]
    {
        let m = fs::metadata(dir)?.permissions().mode() & 0o777;
        if m & 0o077 != 0 {
            fs::set_permissions(dir, fs::Permissions::from_mode(m & 0o700))?;
        }
    }
    Ok(())
}

fn parses(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).is_ok()
}

fn read_text(path: &Path) -> std::io::Result<String> {
    let mut s = String::new();
    File::open(path)?.read_to_string(&mut s)?;
    Ok(s)
}

/// Reads `state.json`, falling back to `.bak` when it does not parse.
pub fn load(dir: &Path) -> Loaded {
    let main = dir.join(STATE);
    match read_text(&main) {
        Err(e) if e.kind() == ErrorKind::NotFound => Loaded { state: None, error: None },
        Ok(text) if parses(&text) => Loaded { state: Some(text), error: None },
        // Present but unreadable or unparseable: keep it for the user as .bad, try the backup.
        _ => {
            let _ = fs::rename(&main, dir.join(BAD));
            match read_text(&dir.join(BAK)) {
                Ok(bak) if parses(&bak) => Loaded { state: Some(bak), error: Some("restored-from-bak") },
                _ => Loaded { state: None, error: Some("unreadable") },
            }
        }
    }
}

/// A canary write: can this directory actually hold a file? (`SCD.persistent`)
pub fn canary(dir: &Path) -> bool {
    let p = dir.join(PROBE);
    let _ = fs::remove_file(&p);
    let ok = write_private(&p, b"1").is_ok() && read_text(&p).map(|s| s == "1").unwrap_or(false);
    let _ = fs::remove_file(&p);
    ok
}

/// Writes `bytes` to `path` through a fresh file created 0600, fsynced.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let _ = fs::remove_file(path); // the mode applies only at creation, so never reuse a file
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    o.mode(0o600);
    let mut f = o.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn remove_if_present(p: &Path) -> Result<(), String> {
    match fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not delete {}: {e}", p.display())),
    }
}

/// Saves (or, with `None`, deletes) the state. Returns the saved-at time in ms.
/// The caller holds the save lock for the whole call.
pub fn save(dir: &Path, json: Option<&str>) -> Result<u64, String> {
    let main = dir.join(STATE);
    let Some(text) = json else {
        remove_if_present(&main)?;
        remove_if_present(&dir.join(BAK))?;
        remove_if_present(&dir.join(TMP))?;
        sync_dir(dir);
        return Ok(now_ms());
    };
    if text.len() > MAX_BYTES {
        return Err(format!("the state is {} MB, over the 20 MB limit", text.len() / (1024 * 1024)));
    }
    if !parses(text) {
        return Err("the state is not valid JSON".into());
    }
    let (clean, _) = scrub(text); // R-95: a key value never reaches the disk from the webview
    let text = clean.as_str();
    // Back up the current file only if it is good: a corrupt file must never replace the backup.
    if let Ok(cur) = read_text(&main) {
        if parses(&cur) {
            let tmp_bak: PathBuf = dir.join("state.json.bak.tmp");
            write_private(&tmp_bak, cur.as_bytes()).map_err(|e| format!("could not write the backup: {e}"))?;
            fs::rename(&tmp_bak, dir.join(BAK)).map_err(|e| format!("could not write the backup: {e}"))?;
        }
    }
    let tmp = dir.join(TMP);
    write_private(&tmp, text.as_bytes()).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &main).map_err(|e| format!("could not replace {}: {e}", main.display()))?;
    sync_dir(dir);
    Ok(now_ms())
}

/* ---------- v2: settings.json (Rust-owned) and the state.json key scrub (§13.3, R-95) ---------- */

pub const SETTINGS: &str = "settings.json";
pub const KEYS_FILE: &str = "keys.json";

/// Where Rust last stored a provider's key, so a boot can say `present` without touching the
/// keystore (R-94).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ProviderSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub stored: Option<String>, // "keychain" | "file" | None
}

/// `settings.json`, written only by Rust (mode 0600, atomically). The webview never sees the
/// file; it gets `boot.cloud` and the `stagecraft://cloud` event instead (R-110).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub v: u32,
    #[serde(default)]
    pub cloud_opt_in: bool,
    #[serde(default)]
    pub opt_in_at: Option<u64>,
    #[serde(default)]
    pub providers: std::collections::BTreeMap<String, ProviderSettings>,
    #[serde(default)]
    pub key_file_consent_at: std::collections::BTreeMap<String, u64>,
    /// R1 (2026-11-18): chat calls per provider per UTC day, as (day number, count). Enforced in
    /// Rust so no page bug, autopilot or revision loop can call without limit.
    #[serde(default)]
    pub calls: std::collections::BTreeMap<String, (u64, u32)>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { v: 2, cloud_opt_in: false, opt_in_at: None, providers: Default::default(), key_file_consent_at: Default::default(), calls: Default::default() }
    }
}

/// A missing or unreadable `settings.json` is a cloud-off first run: nothing is ever turned on
/// by a file Rust cannot read.
pub fn load_settings(dir: &Path) -> Settings {
    match read_text(&dir.join(SETTINGS)) {
        Ok(t) => serde_json::from_str::<Settings>(&t).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// Writes `bytes` to `dir/name` atomically through a fresh 0600 file (R-75).
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = dir.join(format!("{name}.tmp"));
    write_private(&tmp, bytes).map_err(|e| format!("could not write {name}: {e}"))?;
    fs::rename(&tmp, dir.join(name)).map_err(|e| format!("could not replace {name}: {e}"))?;
    sync_dir(dir);
    Ok(())
}

pub fn save_settings(dir: &Path, s: &Settings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    write_atomic(dir, SETTINGS, text.as_bytes())
}

pub fn remove_named(dir: &Path, name: &str) -> Result<(), String> {
    remove_if_present(&dir.join(name))?;
    remove_if_present(&dir.join(format!("{name}.tmp")))?;
    sync_dir(dir);
    Ok(())
}

/// `keys.json`: only ever written after the user said Yes to Rust's own dialog (R-94).
pub fn load_key_file(dir: &Path) -> std::collections::BTreeMap<String, String> {
    read_text(&dir.join(KEYS_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_key_file(dir: &Path, keys: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
    if keys.is_empty() {
        return remove_named(dir, KEYS_FILE);
    }
    let text = serde_json::to_string(keys).map_err(|e| e.to_string())?;
    write_atomic(dir, KEYS_FILE, text.as_bytes())
}

/// R-95: every `keys.<id>` other than `local` whose value is not exactly the marker
/// `"keychain"` is deleted, never migrated. Returns the rewritten text and the ids removed;
/// a text that is not a JSON object, or has nothing to remove, comes back unchanged.
pub fn scrub(text: &str) -> (String, Vec<String>) {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) else {
        return (text.to_string(), vec![]);
    };
    let mut gone = vec![];
    if let Some(keys) = v.get_mut("keys").and_then(|k| k.as_object_mut()) {
        let ids: Vec<String> = keys.keys().cloned().collect();
        for id in ids {
            if id == "local" {
                continue;
            }
            if keys.get(&id).and_then(|x| x.as_str()) != Some("keychain") {
                keys.remove(&id);
                gone.push(id);
            }
        }
    } else if v.get("keys").is_some_and(|k| !k.is_null()) {
        // A `keys` that is not an object can only be a planted or corrupt value: drop it whole.
        v.as_object_mut().map(|o| o.remove("keys"));
        gone.push("keys".into());
    }
    // 2026-11-17 (sessions): archived walkthroughs live in `sessions`, and the page copies only a
    // whitelist of per-idea fields into one, so a session never holds keys. A `keys` member inside
    // one can only be planted or corrupt: it is dropped whole (the marker too - it means nothing
    // there), and its ids are reported like a top-level key so the R-95 notice names them.
    let mut nested = false;
    if let Some(list) = v.get_mut("sessions").and_then(|s| s.as_array_mut()) {
        for item in list.iter_mut() {
            let Some(k) = item.as_object_mut().and_then(|o| o.remove("keys")) else { continue };
            nested = true;
            let ids: Vec<String> = match k.as_object() {
                Some(m) => m
                    .iter()
                    .filter(|(id, val)| id.as_str() != "local" && val.as_str() != Some("keychain"))
                    .map(|(id, _)| id.clone())
                    .collect(),
                None if k.is_null() => vec![],
                None => vec!["keys".to_string()],
            };
            for id in ids {
                if !gone.contains(&id) {
                    gone.push(id);
                }
            }
        }
    }
    if gone.is_empty() && !nested {
        return (text.to_string(), gone);
    }
    (serde_json::to_string(&v).unwrap_or_else(|_| text.to_string()), gone)
}

/// Boot half of R-95: scrubs `state.json` AND its `.bak` on disk (the backup would otherwise
/// keep the value, and a later restore would bring it back), before the page is built.
/// Returns the scrubbed load and the ids removed.
pub fn load_scrubbed(dir: &Path) -> (Loaded, Vec<String>) {
    let mut gone: Vec<String> = vec![];
    for name in [STATE, BAK] {
        if let Ok(t) = read_text(&dir.join(name)) {
            if parses(&t) {
                let (clean, ids) = scrub(&t);
                if !ids.is_empty() {
                    let _ = write_atomic(dir, name, clean.as_bytes());
                    for id in ids {
                        if !gone.contains(&id) {
                            gone.push(id);
                        }
                    }
                }
            }
        }
    }
    let mut loaded = load(dir);
    if let Some(t) = &loaded.state {
        let (clean, ids) = scrub(t); // a .bak restored by load() was scrubbed above; belt and braces
        loaded.state = Some(clean);
        for id in ids {
            if !gone.contains(&id) {
                gone.push(id);
            }
        }
    }
    gone.sort();
    (loaded, gone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);
    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "stagecraft-state-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&d);
        prepare_dir(&d).unwrap();
        d
    }
    #[cfg(unix)]
    fn mode(p: &Path) -> u32 {
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn first_run_is_empty() {
        let d = tmpdir();
        assert_eq!(load(&d), Loaded { state: None, error: None });
    }

    #[test]
    fn save_then_load_round_trips() {
        let d = tmpdir();
        save(&d, Some(r#"{"idea":"a"}"#)).unwrap();
        assert_eq!(load(&d).state.as_deref(), Some(r#"{"idea":"a"}"#));
    }

    #[cfg(unix)]
    #[test]
    fn files_are_private() {
        let d = tmpdir();
        assert_eq!(mode(&d), 0o700);
        save(&d, Some(r#"{"n":1}"#)).unwrap();
        save(&d, Some(r#"{"n":2}"#)).unwrap();
        assert_eq!(mode(&d.join(STATE)), 0o600);
        assert_eq!(mode(&d.join(BAK)), 0o600);
    }

    #[test]
    fn backup_holds_the_previous_good_state() {
        let d = tmpdir();
        save(&d, Some(r#"{"n":1}"#)).unwrap();
        save(&d, Some(r#"{"n":2}"#)).unwrap();
        assert_eq!(read_text(&d.join(BAK)).unwrap(), r#"{"n":1}"#);
        assert_eq!(read_text(&d.join(STATE)).unwrap(), r#"{"n":2}"#);
        assert!(!d.join(TMP).exists());
    }

    #[test]
    fn a_corrupt_file_never_replaces_the_backup() {
        let d = tmpdir();
        save(&d, Some(r#"{"n":1}"#)).unwrap();
        save(&d, Some(r#"{"n":2}"#)).unwrap(); // bak = n:1
        fs::write(d.join(STATE), "{not json").unwrap();
        save(&d, Some(r#"{"n":3}"#)).unwrap();
        assert_eq!(read_text(&d.join(BAK)).unwrap(), r#"{"n":1}"#);
    }

    #[test]
    fn corrupt_state_restores_from_bak_and_keeps_bad() {
        let d = tmpdir();
        save(&d, Some(r#"{"n":1}"#)).unwrap();
        save(&d, Some(r#"{"n":2}"#)).unwrap();
        fs::write(d.join(STATE), "{truncated").unwrap();
        let l = load(&d);
        assert_eq!(l.error, Some("restored-from-bak"));
        assert_eq!(l.state.as_deref(), Some(r#"{"n":1}"#));
        assert_eq!(read_text(&d.join(BAD)).unwrap(), "{truncated");
        assert_eq!(read_text(&d.join(BAK)).unwrap(), r#"{"n":1}"#, "the .bak is unchanged");
    }

    #[test]
    fn both_unreadable_loads_nothing() {
        let d = tmpdir();
        fs::write(d.join(STATE), "nope").unwrap();
        fs::write(d.join(BAK), "nope").unwrap();
        assert_eq!(load(&d), Loaded { state: None, error: Some("unreadable") });
        assert!(d.join(BAD).exists());
    }

    #[test]
    fn none_deletes_state_and_backup() {
        let d = tmpdir();
        save(&d, Some(r#"{"n":1}"#)).unwrap();
        save(&d, Some(r#"{"n":2}"#)).unwrap();
        save(&d, None).unwrap();
        assert!(!d.join(STATE).exists() && !d.join(BAK).exists());
        assert_eq!(load(&d).state, None);
        save(&d, None).unwrap(); // deleting twice is fine
    }

    #[test]
    fn invalid_or_oversized_json_is_refused() {
        let d = tmpdir();
        assert!(save(&d, Some("{oops")).is_err());
        let big = format!("\"{}\"", "x".repeat(MAX_BYTES));
        assert!(save(&d, Some(&big)).is_err());
        assert!(!d.join(STATE).exists());
    }

    #[test]
    fn canary_reports_a_writable_dir() {
        let d = tmpdir();
        assert!(canary(&d));
        assert!(!d.join(PROBE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn canary_reports_a_read_only_dir() {
        // Root ignores directory permissions, so only assert when the check is meaningful.
        let d = tmpdir();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o500)).unwrap();
        let probe = d.join("x");
        let can_write_anyway = File::create(&probe).is_ok();
        let _ = fs::remove_file(&probe);
        if !can_write_anyway {
            assert!(!canary(&d));
            assert!(save(&d, Some("{}")).is_err());
        }
        fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[test]
    fn scrub_keeps_only_the_marker_and_local() {
        let (t, gone) = scrub(r#"{"keys":{"local":"local","groq":"gsk_planted","gemini":"keychain","openrouter":""},"idea":"x"}"#);
        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["keys"], serde_json::json!({"local":"local","gemini":"keychain"}));
        assert_eq!(gone, vec!["groq".to_string(), "openrouter".to_string()]);
        assert_eq!(v["idea"], "x");
        let same = r#"{"keys":{"local":"local"}}"#;
        assert_eq!(scrub(same), (same.to_string(), vec![]));
        assert_eq!(scrub("not json").1.len(), 0);
        assert_eq!(scrub(r#"{"keys":"sk-x"}"#).1, vec!["keys".to_string()]);
    }

    #[test]
    fn boot_scrub_rewrites_state_and_backup() {
        let d = tmpdir();
        save(&d, Some(r#"{"n":1}"#)).unwrap();
        fs::write(d.join(STATE), r#"{"keys":{"groq":"test-only-planted"},"n":2}"#).unwrap();
        fs::write(d.join(BAK), r#"{"keys":{"openrouter":"test-only-planted2"},"n":1}"#).unwrap();
        let (l, gone) = load_scrubbed(&d);
        assert_eq!(gone, vec!["groq".to_string(), "openrouter".to_string()]);
        assert!(!l.state.unwrap().contains("test-only"));
        for f in [STATE, BAK] {
            assert!(!read_text(&d.join(f)).unwrap().contains("test-only"), "{f}");
        }
        #[cfg(unix)]
        assert_eq!(mode(&d.join(STATE)), 0o600);
    }

    #[test]
    fn state_save_scrubs_every_write() {
        let d = tmpdir();
        save(&d, Some(r#"{"keys":{"groq":"test-only-x","local":"local"}}"#)).unwrap();
        let t = read_text(&d.join(STATE)).unwrap();
        assert!(!t.contains("test-only") && t.contains("local"));
    }

    #[test]
    fn scrub_reaches_keys_planted_inside_sessions() {
        let planted = r#"{"keys":{"local":"local"},"sessions":[{"id":"s1","idea":"a","keys":{"groq":"test-only-nested","local":"local","gemini":"keychain"}},{"id":"s2","idea":"b","keys":"sk-x"},{"id":"s3","idea":"c"}]}"#;
        let (t, gone) = scrub(planted);
        assert!(!t.contains("test-only") && !t.contains("sk-x"), "{t}");
        assert_eq!(gone, vec!["groq".to_string(), "keys".to_string()]);
        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
        assert!(v["sessions"].as_array().unwrap().iter().all(|s| s.get("keys").is_none()));
        assert_eq!(v["sessions"][0]["idea"], "a");
        assert_eq!(v["keys"], serde_json::json!({"local":"local"}));
        // A marker alone inside a session is dropped too, with nothing to report.
        let (t2, gone2) = scrub(r#"{"sessions":[{"id":"s1","keys":{"gemini":"keychain"}}]}"#);
        assert!(gone2.is_empty() && !t2.contains("keys"));
        // Clean sessions come back byte for byte.
        let clean = r#"{"keys":{"local":"local"},"sessions":[{"id":"s1","idea":"a","outputs":{}}]}"#;
        assert_eq!(scrub(clean), (clean.to_string(), vec![]));
        // And every write gets it: nothing nested reaches the disk.
        let d = tmpdir();
        save(&d, Some(planted)).unwrap();
        assert!(!read_text(&d.join(STATE)).unwrap().contains("test-only"));
    }

    #[test]
    fn settings_round_trip_atomic_and_private() {
        let d = tmpdir();
        assert_eq!(load_settings(&d), Settings::default());
        let mut s = Settings::default();
        s.cloud_opt_in = true;
        s.providers.insert("groq".into(), ProviderSettings { enabled: true, stored: Some("keychain".into()) });
        save_settings(&d, &s).unwrap();
        assert_eq!(load_settings(&d), s);
        assert!(!d.join("settings.json.tmp").exists());
        #[cfg(unix)]
        assert_eq!(mode(&d.join(SETTINGS)), 0o600);
        fs::write(d.join(SETTINGS), "{garbage").unwrap();
        assert!(!load_settings(&d).cloud_opt_in, "an unreadable file never turns cloud on");
        let text = serde_json::to_string(&s).unwrap();
        assert!(text.contains(r#""cloudOptIn":true"#) && text.contains(r#""v":2"#) && text.contains("keyFileConsentAt"));
    }
}
