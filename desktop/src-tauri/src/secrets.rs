//! v2 keys (DESIGN-desktop §13.4, R-92..R-94). A key is stored in exactly one place: the OS
//! keychain (default), the session map in `GateState` (until exit), or `keys.json`, which is
//! written only after the user says Yes to Rust's own dialog, and only when no keychain exists.
//!
//! The keystore is never touched at a boot with cloud off (R-94): D-Bus activation can start a
//! daemon that asks to create a keyring, and a lookup can raise an unlock prompt.
//!
//! Every error here is a fixed string. No key value reaches an error, a log or a panic message.

use keyring_core::{CredentialStore, Entry, Error as KErr};
use std::sync::{Arc, Mutex};

use crate::gate::Provider;

/// Which store backs the keychain. Only `Native` exists in a release build; the others are
/// debug-only self-test stores (D-26, `STAGECRAFT_SELFTEST_KEYSTORE`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(debug_assertions), allow(dead_code))] // the test stores exist only in debug builds
pub enum Mode {
    Native,
    /// keyring-core's in-memory mock store.
    Mock,
    /// No Secret Service: `keystore:"none"`.
    Fail,
    /// Every store call answers `NoStorageAccess`.
    Locked,
    /// The real store under service `<identifier>.selftest`.
    RealTest,
}

impl Mode {
    /// Debug builds only. A release build always uses the native store.
    pub fn from_env() -> Mode {
        // #[cfg], not cfg!(): the variable's name must not even be in a release binary (A-63).
        #[cfg(debug_assertions)]
        {
            match std::env::var("STAGECRAFT_SELFTEST_KEYSTORE").ok().as_deref().map(str::trim) {
                Some("mock") => return Mode::Mock,
                Some("fail") => return Mode::Fail,
                Some("locked") => return Mode::Locked,
                Some("real-test") => return Mode::RealTest,
                _ => {}
            }
            // v2 review: the mock provider never gets a key from the user's real keychain. With
            // the mock on and no test keystore named, use the in-memory mock store.
            if std::env::var("STAGECRAFT_SELFTEST_MOCKCLOUD").is_ok_and(|v| !v.trim().is_empty()) {
                return Mode::Mock;
            }
        }
        Mode::Native
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KsErr {
    /// No session bus or no Secret Service daemon (R-94 "None").
    NoKeystore,
    /// `NoStorageAccess`: a locked keychain, a dismissed prompt, no default collection.
    Locked,
    Failed,
}

impl KsErr {
    pub fn status(&self) -> &'static str {
        match self {
            KsErr::NoKeystore => "none",
            KsErr::Locked => "locked",
            KsErr::Failed => "locked",
        }
    }
}

fn map_err(e: &KErr) -> KsErr {
    match e {
        KErr::NoStorageAccess(_) => KsErr::Locked,
        KErr::NoDefaultStore => KsErr::NoKeystore,
        _ => KsErr::Failed,
    }
}

pub struct Keystore {
    pub mode: Mode,
    pub service: String,
    store: Mutex<Option<Arc<CredentialStore>>>,
    /// Unit tests only: every store call answers this error while it is set, so a test can
    /// lock a keychain and unlock it again in one process.
    #[cfg(test)]
    pub inject: Mutex<Option<KsErr>>,
}

impl Keystore {
    pub fn new(mode: Mode, identifier: &str) -> Keystore {
        let service = if mode == Mode::RealTest { format!("{identifier}.selftest") } else { identifier.to_string() };
        Keystore {
            mode,
            service,
            store: Mutex::new(None),
            #[cfg(test)]
            inject: Mutex::new(None),
        }
    }

    fn native() -> Result<Arc<CredentialStore>, KsErr> {
        #[cfg(target_os = "linux")]
        {
            match zbus_secret_service_keyring_store::Store::new() {
                Ok(s) => Ok(s as Arc<CredentialStore>),
                Err(KErr::NoStorageAccess(_)) => Err(KsErr::Locked),
                Err(_) => Err(KsErr::NoKeystore),
            }
        }
        #[cfg(target_os = "macos")]
        {
            apple_native_keyring_store::keychain::Store::new().map(|s| s as Arc<CredentialStore>).map_err(|e| map_err(&e))
        }
        #[cfg(target_os = "windows")]
        {
            windows_native_keyring_store::Store::new().map(|s| s as Arc<CredentialStore>).map_err(|e| map_err(&e))
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            Err(KsErr::NoKeystore)
        }
    }

    /// `Store::new()` once; the answer is `keystore` in `CloudState`. Blocking: call it from
    /// `spawn_blocking`, and only while cloud is on.
    pub fn probe(&self) -> &'static str {
        match self.handle() {
            Ok(_) => "keychain",
            Err(e) => e.status(),
        }
    }

    fn handle(&self) -> Result<Arc<CredentialStore>, KsErr> {
        #[cfg(test)]
        if let Some(e) = self.inject.lock().map_err(|_| KsErr::Failed)?.clone() {
            return Err(e);
        }
        match self.mode {
            Mode::Fail => return Err(KsErr::NoKeystore),
            Mode::Locked => return Err(KsErr::Locked),
            _ => {}
        }
        let mut g = self.store.lock().map_err(|_| KsErr::Failed)?;
        if let Some(s) = g.as_ref() {
            return Ok(s.clone());
        }
        let s = match self.mode {
            Mode::Mock => keyring_core::mock::Store::new().map(|s| s as Arc<CredentialStore>).map_err(|e| map_err(&e))?,
            _ => Keystore::native()?,
        };
        *g = Some(s.clone());
        Ok(s)
    }

    fn entry(&self, p: Provider) -> Result<Entry, KsErr> {
        let s = self.handle()?;
        s.build(&self.service, p.id(), None).map_err(|e| map_err(&e))
    }

    pub fn get(&self, p: Provider) -> Result<Option<String>, KsErr> {
        match self.entry(p)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(KErr::NoEntry) => Ok(None),
            Err(e) => Err(map_err(&e)),
        }
    }

    pub fn set(&self, p: Provider, value: &str) -> Result<(), KsErr> {
        self.entry(p)?.set_password(value).map_err(|e| map_err(&e))
    }

    /// A missing entry is `Ok` (`secret_delete`).
    pub fn delete(&self, p: Provider) -> Result<(), KsErr> {
        match self.entry(p)?.delete_credential() {
            Ok(()) | Err(KErr::NoEntry) => Ok(()),
            Err(e) => Err(map_err(&e)),
        }
    }
}

/// R-92 step 2: trimmed, 8–512 printable ASCII characters, no whitespace. `None` refuses it.
pub fn valid_key(value: &str) -> Option<String> {
    let v = value.trim();
    if v.len() < 8 || v.len() > 512 {
        return None;
    }
    if !v.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return None;
    }
    Some(v.to_string())
}

/* ---------- the vault: where a key goes, and where the next call finds it ---------- */

/// `secret_set`'s answer (R-92). Never carries the key.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub stored: bool,
    /// ok | rejected | error | unreachable | rate-limited | no-keystore | locked | not-allowed
    pub status: String,
    pub store: Option<String>,
    pub http_status: Option<u16>,
}

impl KeyCheck {
    pub fn no(status: &str, http: Option<u16>) -> KeyCheck {
        KeyCheck { stored: false, status: status.into(), store: None, http_status: http }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct KeyState {
    pub present: bool,
    pub store: Option<String>,
}

/// The page's `store` argument. `None` is the default: the keychain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    Keychain,
    Session,
    File,
}

impl Choice {
    pub fn parse(s: Option<&str>) -> Option<Choice> {
        match s {
            None | Some("") | Some("keychain") => Some(Choice::Keychain),
            Some("session") => Some(Choice::Session),
            Some("file") => Some(Choice::File),
            _ => None,
        }
    }
}

use crate::gate::GateState;
use crate::state;
use std::path::Path;

fn lock(g: &Mutex<GateState>) -> std::sync::MutexGuard<'_, GateState> {
    g.lock().unwrap_or_else(|e| e.into_inner())
}

/// Stores an already-checked key in exactly one place (R-93), then deletes the provider's
/// entry from every other store. `confirm_file` is Rust's own dialog for a `keys.json` write;
/// it is asked on every file write, for each provider (R-94). Writes `settings.json`.
pub fn store(
    ks: &Keystore,
    dir: &Path,
    gate: &Mutex<GateState>,
    p: Provider,
    value: &str,
    choice: Choice,
    confirm_file: &dyn Fn() -> bool,
) -> KeyCheck {
    let (keystore, old_record) = {
        let g = lock(gate);
        (g.keystore.clone(), g.stored(p))
    };
    let stored_as: &'static str = match choice {
        Choice::Session => "session",
        Choice::File => {
            // R-94: offered only when no keychain exists; with one, it weakens nothing to refuse.
            if keystore != "none" {
                return KeyCheck::no("not-allowed", None);
            }
            if !confirm_file() {
                return KeyCheck::no("declined", None);
            }
            let mut keys = state::load_key_file(dir);
            keys.insert(p.id().to_string(), value.to_string());
            if state::save_key_file(dir, &keys).is_err() {
                return KeyCheck::no("error", None);
            }
            "file"
        }
        Choice::Keychain => match ks.set(p, value) {
            Ok(()) => "keychain",
            Err(KsErr::NoKeystore) => {
                lock(gate).keystore = "none".into();
                return KeyCheck::no("no-keystore", None);
            }
            Err(_) => {
                lock(gate).keystore = "locked".into();
                return KeyCheck::no("locked", None);
            }
        },
    };
    // One place only: remove the provider's entry everywhere else. A keychain entry the record
    // says exists is deleted even while the keychain looks locked; if that delete is not
    // confirmed, the record stays (v2 review), or the old key would be orphaned with nothing
    // left pointing at it.
    let mut keep_keychain_record = false;
    if stored_as != "keychain" && ks.mode != Mode::Fail {
        let recorded = old_record.as_deref() == Some("keychain");
        if (keystore == "keychain" || recorded) && ks.delete(p).is_err() && recorded {
            keep_keychain_record = true;
        }
    }
    if stored_as != "file" {
        let mut keys = state::load_key_file(dir);
        if keys.remove(p.id()).is_some() {
            let _ = state::save_key_file(dir, &keys);
        }
    }
    let mut g = lock(gate);
    if stored_as == "session" {
        g.session_keys.insert(p, value.to_string());
        g.keys.remove(&p);
        g.set_stored(p, if keep_keychain_record { Some("keychain") } else { None });
    } else {
        g.session_keys.remove(&p);
        g.keys.insert(p, value.to_string());
        g.set_stored(p, Some(stored_as));
        if stored_as == "file" {
            g.settings.key_file_consent_at.insert(p.id().to_string(), now_ms());
            g.file_ok.insert(p); // just confirmed by the user, in this session
        } else {
            g.settings.key_file_consent_at.remove(p.id());
            g.file_ok.remove(&p);
        }
    }
    let _ = state::save_settings(dir, &g.settings);
    KeyCheck { stored: true, status: "ok".into(), store: Some(stored_as.into()), http_status: None }
}

/// The key the next request would carry (R-93 lookup order): the session map, then the
/// cache, then the keychain, then a `keys.json` entry confirmed at this boot. Blocking.
/// A stale `stored:"keychain"` is cleared here (R-94), and the caller emits the new state.
pub fn lookup(ks: &Keystore, dir: &Path, gate: &Mutex<GateState>, p: Provider) -> (Option<String>, bool) {
    let (stored, file_ok) = {
        let g = lock(gate);
        if let Some(k) = g.session_keys.get(&p) {
            return (Some(k.clone()), false);
        }
        if let Some(k) = g.keys.get(&p) {
            return (Some(k.clone()), false);
        }
        (g.stored(p), g.file_ok.contains(&p))
    };
    let found = match stored.as_deref() {
        Some("keychain") => match ks.get(p) {
            Ok(v) => v,
            Err(_) => return (None, false), // locked or gone: no key, but nothing is stale yet
        },
        Some("file") if file_ok => state::load_key_file(dir).get(p.id()).cloned(),
        _ => None,
    };
    let mut g = lock(gate);
    match found {
        Some(k) => {
            if g.on {
                g.keys.insert(p, k.clone()); // cached until off, delete or exit
            }
            (Some(k), false)
        }
        None if stored.is_some() && (stored.as_deref() != Some("file") || file_ok) => {
            g.set_stored(p, None);
            let _ = state::save_settings(dir, &g.settings);
            (None, true)
        }
        None => (None, false),
    }
}

/// `secret_has`: reads `settings.json`'s record and the session map. No keystore call.
pub fn has(gate: &Mutex<GateState>, p: Provider) -> KeyState {
    let g = lock(gate);
    let st = g.snapshot();
    let ps = &st.providers[p.id()];
    KeyState { present: ps.present, store: ps.store.clone() }
}

/// `secret_delete`: every store; a missing entry is `Ok`. The keychain is asked only when a
/// record says a key may be there, or while cloud is on (R-94).
pub fn delete(ks: &Keystore, dir: &Path, gate: &Mutex<GateState>, p: Provider) -> Result<(), String> {
    let (recorded, touch_keychain, has_file) = {
        let mut g = lock(gate);
        g.session_keys.remove(&p);
        g.keys.remove(&p);
        g.file_ok.remove(&p);
        let recorded = g.stored(p).as_deref() == Some("keychain");
        (recorded, recorded || g.on, g.stored(p).as_deref() == Some("file"))
    };
    // Only a confirmed delete (Ok, or no entry) clears a keychain record (v2 review). Any other
    // answer keeps it, so the sheet keeps offering [Delete the key] and never says "deleted".
    let mut err = None;
    if touch_keychain {
        if let Err(e) = ks.delete(p) {
            if recorded {
                err = Some(delete_err(&e).to_string());
            }
        }
    }
    let mut keys = state::load_key_file(dir);
    if keys.remove(p.id()).is_some() || has_file {
        state::save_key_file(dir, &keys)?;
    }
    let mut g = lock(gate);
    if err.is_none() {
        g.set_stored(p, None);
        g.settings.key_file_consent_at.remove(p.id());
    }
    state::save_settings(dir, &g.settings)?;
    match err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// The fixed code a failed keychain delete reports (`secret_delete`, Forget everything).
pub fn delete_err(e: &KsErr) -> &'static str {
    match e {
        KsErr::Locked => "locked",
        KsErr::NoKeystore => "no-keystore",
        KsErr::Failed => "failed",
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::gate::GateState;
    use crate::state::{self, Settings};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);
    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("stagecraft-secrets-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&d);
        state::prepare_dir(&d).unwrap();
        d
    }
    fn opted_in(keystore: &str) -> Mutex<GateState> {
        let mut s = Settings::default();
        s.cloud_opt_in = true;
        let mut g = GateState::new(s, vec![]);
        g.keystore = keystore.into();
        g.set_enabled(Provider::Groq, true);
        Mutex::new(g)
    }
    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap_or_default()
    }

    #[test]
    fn a_keychain_key_is_recorded_but_never_written_to_a_file() {
        let (d, ks, g) = (dir(), Keystore::new(Mode::Mock, "t"), opted_in("keychain"));
        ks.probe();
        let r = store(&ks, &d, &g, Provider::Groq, "test-only-groq-11111111", Choice::Keychain, &|| panic!("no dialog"));
        assert_eq!(r.status, "ok");
        assert_eq!(r.store.as_deref(), Some("keychain"));
        assert!(!read(&d.join("settings.json")).contains("test-only"), "A-40: no key in settings.json");
        assert!(read(&d.join("settings.json")).contains(r#""stored": "keychain""#));
        assert!(!d.join("keys.json").exists());
        assert_eq!(has(&g, Provider::Groq), KeyState { present: true, store: Some("keychain".into()) });
        // a fresh process: no cache, found in the keychain
        g.lock().unwrap().keys.clear();
        assert_eq!(lookup(&ks, &d, &g, Provider::Groq).0.as_deref(), Some("test-only-groq-11111111"));
        delete(&ks, &d, &g, Provider::Groq).unwrap();
        assert_eq!(ks.get(Provider::Groq), Ok(None));
        assert!(!has(&g, Provider::Groq).present);
    }

    #[test]
    fn a_stale_keychain_record_is_cleared_on_first_use() {
        let (d, ks, g) = (dir(), Keystore::new(Mode::Mock, "t"), opted_in("keychain"));
        g.lock().unwrap().set_stored(Provider::Groq, Some("keychain"));
        assert!(has(&g, Provider::Groq).present);
        let (k, changed) = lookup(&ks, &d, &g, Provider::Groq);
        assert!(k.is_none() && changed);
        assert!(!has(&g, Provider::Groq).present);
    }

    #[test]
    fn session_keys_win_and_survive_opt_out_but_not_a_relaunch() {
        let (d, ks, g) = (dir(), Keystore::new(Mode::Fail, "t"), opted_in("none"));
        let r = store(&ks, &d, &g, Provider::Groq, "test-only-groq-22222222", Choice::Session, &|| panic!("no dialog"));
        assert_eq!(r.store.as_deref(), Some("session"));
        assert_eq!(has(&g, Provider::Groq).store.as_deref(), Some("session"));
        assert!(!read(&d.join("settings.json")).contains("test-only"));
        g.lock().unwrap().on = false; // cloud_disable keeps the session map (R-87 step 3)
        assert_eq!(lookup(&ks, &d, &g, Provider::Groq).0.as_deref(), Some("test-only-groq-22222222"));
        // relaunch: a new GateState from the same settings.json
        let g2 = Mutex::new(GateState::new(state::load_settings(&d), vec![]));
        assert!(!has(&g2, Provider::Groq).present, "A-56: a session key is gone after relaunch");
    }

    #[test]
    fn a_key_file_needs_no_keychain_and_a_yes_every_time() {
        let (d, ks) = (dir(), Keystore::new(Mode::Fail, "t"));
        let g = opted_in("none");
        let r = store(&ks, &d, &g, Provider::Groq, "test-only-groq-33333333", Choice::File, &|| false);
        assert_eq!(r.status, "declined");
        assert!(!d.join("keys.json").exists(), "A-56: nothing written on No");
        let r = store(&ks, &d, &g, Provider::Groq, "test-only-groq-33333333", Choice::File, &|| true);
        assert_eq!(r.store.as_deref(), Some("file"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join("keys.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let s = state::load_settings(&d);
        assert!(s.key_file_consent_at.contains_key("groq"));
        let asked = std::cell::Cell::new(0);
        g.lock().unwrap().set_enabled(Provider::Gemini, true);
        store(&ks, &d, &g, Provider::Gemini, "test-only-gemini-4444", Choice::File, &|| { asked.set(asked.get() + 1); true });
        assert_eq!(asked.get(), 1, "a second provider's file write asks again");
        // relaunch: the file key is not used until this boot's confirm (R-109)
        let g2 = Mutex::new(GateState::new(state::load_settings(&d), vec![]));
        assert_eq!(lookup(&ks, &d, &g2, Provider::Groq).0, None);
        g2.lock().unwrap().file_ok.insert(Provider::Groq);
        assert_eq!(lookup(&ks, &d, &g2, Provider::Groq).0.as_deref(), Some("test-only-groq-33333333"));
        delete(&ks, &d, &g2, Provider::Groq).unwrap();
        assert!(!read(&d.join("keys.json")).contains("groq"));
    }

    #[test]
    fn file_storage_is_refused_when_a_keychain_exists() {
        let (d, ks, g) = (dir(), Keystore::new(Mode::Mock, "t"), opted_in("keychain"));
        let r = store(&ks, &d, &g, Provider::Groq, "test-only-groq-55555555", Choice::File, &|| panic!("never asked"));
        assert_eq!(r.status, "not-allowed");
        assert!(!d.join("keys.json").exists());
    }

    #[test]
    fn storing_in_one_place_removes_the_others() {
        let (d, ks, g) = (dir(), Keystore::new(Mode::Mock, "t"), opted_in("keychain"));
        ks.probe();
        store(&ks, &d, &g, Provider::Groq, "test-only-groq-66666666", Choice::Keychain, &|| false);
        store(&ks, &d, &g, Provider::Groq, "test-only-groq-77777777", Choice::Session, &|| false);
        assert_eq!(ks.get(Provider::Groq), Ok(None), "the keychain copy is gone");
        assert_eq!(state::load_settings(&d).providers["groq"].stored, None);
        store(&ks, &d, &g, Provider::Groq, "test-only-groq-88888888", Choice::Keychain, &|| false);
        assert!(!g.lock().unwrap().session_keys.contains_key(&Provider::Groq), "the session copy is gone");
    }

    #[test]
    fn a_locked_keychain_stores_nothing() {
        let (d, ks, g) = (dir(), Keystore::new(Mode::Locked, "t"), opted_in("locked"));
        let r = store(&ks, &d, &g, Provider::Groq, "test-only-groq-99999999", Choice::Keychain, &|| panic!());
        assert_eq!((r.stored, r.status.as_str()), (false, "locked"));
        let r = store(&ks, &d, &g, Provider::Groq, "test-only-groq-99999999", Choice::File, &|| panic!());
        assert_eq!(r.status, "not-allowed", "locked offers session only");
        let r = store(&ks, &d, &g, Provider::Groq, "test-only-groq-99999999", Choice::Session, &|| panic!());
        assert!(r.stored);
    }

    #[test]
    fn a_keychain_delete_that_is_not_confirmed_keeps_the_record() {
        for (inj, code) in [(KsErr::Locked, "locked"), (KsErr::Failed, "failed"), (KsErr::NoKeystore, "no-keystore")] {
            let (d, ks, g) = (dir(), Keystore::new(Mode::Mock, "t"), opted_in("keychain"));
            store(&ks, &d, &g, Provider::Groq, "test-only-groq-dddddddd", Choice::Keychain, &|| panic!());
            *ks.inject.lock().unwrap() = Some(inj);
            assert_eq!(delete(&ks, &d, &g, Provider::Groq), Err(code.to_string()), "{code}");
            *ks.inject.lock().unwrap() = None;
            assert_eq!(ks.get(Provider::Groq).unwrap().as_deref(), Some("test-only-groq-dddddddd"), "the key is still there");
            assert_eq!(has(&g, Provider::Groq).store.as_deref(), Some("keychain"), "{code}: the record says so");
            assert_eq!(state::load_settings(&d).providers["groq"].stored.as_deref(), Some("keychain"), "{code}: and survives a relaunch");
            delete(&ks, &d, &g, Provider::Groq).unwrap();
            assert_eq!(ks.get(Provider::Groq), Ok(None));
            assert!(!has(&g, Provider::Groq).present, "a confirmed delete clears it");
        }
    }

    #[test]
    fn a_session_key_over_an_unreachable_keychain_key_keeps_its_record() {
        let (d, ks, g) = (dir(), Keystore::new(Mode::Mock, "t"), opted_in("keychain"));
        store(&ks, &d, &g, Provider::Groq, "test-only-groq-eeeeeeee", Choice::Keychain, &|| panic!());
        g.lock().unwrap().keystore = "locked".into(); // what a later boot's probe can set
        *ks.inject.lock().unwrap() = Some(KsErr::Locked);
        let r = store(&ks, &d, &g, Provider::Groq, "test-only-groq-ffffffff", Choice::Session, &|| panic!());
        assert_eq!(r.store.as_deref(), Some("session"));
        *ks.inject.lock().unwrap() = None;
        let g2 = Mutex::new(GateState::new(state::load_settings(&d), vec![]));
        assert_eq!(has(&g2, Provider::Groq).store.as_deref(), Some("keychain"), "after a relaunch the old key is still found, not orphaned");
        // reachable this time: the old entry is deleted and the record cleared
        let (d, ks, g) = (dir(), Keystore::new(Mode::Mock, "t"), opted_in("keychain"));
        store(&ks, &d, &g, Provider::Groq, "test-only-groq-eeeeeeee", Choice::Keychain, &|| panic!());
        g.lock().unwrap().keystore = "locked".into();
        store(&ks, &d, &g, Provider::Groq, "test-only-groq-ffffffff", Choice::Session, &|| panic!());
        assert_eq!(ks.get(Provider::Groq), Ok(None), "deleted although the cached state said locked");
        assert_eq!(state::load_settings(&d).providers["groq"].stored, None);
    }

    #[test]
    fn key_shape_is_checked_before_anything_else() {
        assert_eq!(valid_key("  test-only-groq-0123456789abcdef \n").as_deref(), Some("test-only-groq-0123456789abcdef"));
        for bad in ["", "short", "has space inside", "tab\there-12345", &"x".repeat(513), "nonascii-é-123456", "ctrl\u{7}-12345678"] {
            assert!(valid_key(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn mock_store_sets_gets_and_deletes() {
        let ks = Keystore::new(Mode::Mock, "local.stagecraft.desktop");
        assert_eq!(ks.probe(), "keychain");
        assert_eq!(ks.get(Provider::Groq), Ok(None));
        ks.set(Provider::Groq, "test-only-groq-aaaaaaaa").unwrap();
        assert_eq!(ks.get(Provider::Groq).unwrap().as_deref(), Some("test-only-groq-aaaaaaaa"));
        assert_eq!(ks.get(Provider::Gemini), Ok(None), "one entry per provider");
        ks.delete(Provider::Groq).unwrap();
        assert_eq!(ks.get(Provider::Groq), Ok(None));
        ks.delete(Provider::Groq).unwrap(); // deleting a missing entry is fine
    }

    #[test]
    fn fail_and_locked_stores_report_their_state() {
        let f = Keystore::new(Mode::Fail, "x");
        assert_eq!(f.probe(), "none");
        assert_eq!(f.set(Provider::Groq, "test-only-1234"), Err(KsErr::NoKeystore));
        let l = Keystore::new(Mode::Locked, "x");
        assert_eq!(l.probe(), "locked");
        assert_eq!(l.get(Provider::Groq), Err(KsErr::Locked));
        assert_eq!(l.delete(Provider::Groq), Err(KsErr::Locked));
    }

    #[test]
    fn real_test_uses_its_own_service_name() {
        assert_eq!(Keystore::new(Mode::RealTest, "local.stagecraft.desktop").service, "local.stagecraft.desktop.selftest");
        assert_eq!(Keystore::new(Mode::Native, "local.stagecraft.desktop").service, "local.stagecraft.desktop");
    }
    /// A-40 Rust half, against the REAL Secret Service, under the throwaway service
    /// `<identifier>.selftest`, with an obviously fake value: set, "restart" (a fresh store
    /// connection), check, delete. Run by hand: `cargo test -- --ignored real_keychain`.
    #[test]
    #[ignore]
    fn real_keychain_round_trip() {
        let value = format!("test-only-groq-{:016x}", std::process::id() as u64 * 0x9e37_79b9);
        let a = Keystore::new(Mode::RealTest, "local.stagecraft.desktop");
        assert_eq!(a.probe(), "keychain", "needs a running Secret Service");
        a.set(Provider::Groq, &value).unwrap();
        drop(a);
        let b = Keystore::new(Mode::RealTest, "local.stagecraft.desktop");
        assert_eq!(b.get(Provider::Groq).unwrap().as_deref(), Some(value.as_str()), "found after a restart");
        b.delete(Provider::Groq).unwrap();
        let c = Keystore::new(Mode::RealTest, "local.stagecraft.desktop");
        assert_eq!(c.get(Provider::Groq), Ok(None), "no entry remains after delete");
    }
}
