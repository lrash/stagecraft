//! v2: the cloud gate (DESIGN-desktop §13.3, R-110). Everything the page may know about cloud
//! use is a `CloudState`, built here from Rust's own memory and `settings.json`. The page never
//! decides whether cloud is on; it only reads this, from the boot object, from every cloud
//! command's reply, and from the `stagecraft://cloud` event.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use crate::state::{ProviderSettings, Settings};

/// The three v2 providers (R-81). An unknown string is refused before any work.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openrouter,
    Groq,
    Gemini,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Openrouter, Provider::Groq, Provider::Gemini];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Openrouter => "openrouter",
            Provider::Groq => "groq",
            Provider::Gemini => "gemini",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Provider::Openrouter => "OpenRouter",
            Provider::Groq => "Groq",
            Provider::Gemini => "Google AI Studio",
        }
    }

    pub fn parse(s: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|p| p.id() == s)
    }
}

/// One provider as the page sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProviderState {
    pub enabled: bool,
    pub present: bool,
    /// "keychain" | "session" | "file" | null
    pub store: Option<String>,
}

/// R-110: exactly the shape of the boot field `cloud`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CloudState {
    pub on: bool,
    /// "keychain" | "none" | "locked" | "unknown"
    pub keystore: String,
    pub providers: BTreeMap<String, ProviderState>,
    pub scrubbed: Vec<String>,
}

/// A request Rust is running for a window. `sent` turns true just before the request is handed
/// to the network, so a cancel after that point is reported as `cancelled:sent` and counted.
pub struct Inflight {
    pub provider: Provider,
    #[allow(dead_code)] // the same flag the request task reads; kept for diagnostics
    pub sent: Arc<AtomicBool>,
    pub cancel: Option<tokio::sync::oneshot::Sender<()>>,
}

/// `CloudGate = Mutex<GateState>` (§13.3). Keys never leave this struct toward the page.
pub struct GateState {
    pub on: bool,
    pub enabled: HashSet<Provider>,
    /// Cached copies of keychain and file keys, dropped on off, delete or exit (R-93).
    pub keys: HashMap<Provider, String>,
    /// Keys the user chose to keep only until Stagecraft closes. They survive opt-out (R-93).
    pub session_keys: HashMap<Provider, String>,
    pub free_openrouter: Option<(Instant, HashSet<String>)>,
    pub inflight: HashMap<(String, u32), Inflight>,
    pub keystore: String,
    /// The mirror of `settings.json`; every change is written back atomically.
    pub settings: Settings,
    /// Providers whose `keys.json` key the user confirmed at this boot (R-109).
    pub file_ok: HashSet<Provider>,
    pub scrubbed: Vec<String>,
    /// `cloud.json` is added at most once per process; there is no remove.
    pub cap_added: bool,
    /// Sent requests a replaced window can no longer count (D-4), per provider id. Drained into
    /// the next window's boot object (`cloudUnrecorded`).
    pub unrecorded: BTreeMap<String, u32>,
}

impl GateState {
    pub fn new(settings: Settings, scrubbed: Vec<String>) -> GateState {
        let on = settings.cloud_opt_in;
        let enabled = if on {
            settings
                .providers
                .iter()
                .filter(|(_, v)| v.enabled)
                .filter_map(|(k, _)| Provider::parse(k))
                .collect()
        } else {
            HashSet::new()
        };
        GateState {
            on,
            enabled,
            keys: HashMap::new(),
            session_keys: HashMap::new(),
            free_openrouter: None,
            inflight: HashMap::new(),
            keystore: "unknown".into(),
            settings,
            file_ok: HashSet::new(),
            scrubbed,
            cap_added: false,
            unrecorded: BTreeMap::new(),
        }
    }

    pub fn stored(&self, p: Provider) -> Option<String> {
        self.settings.providers.get(p.id()).and_then(|s| s.stored.clone())
    }

    pub fn set_stored(&mut self, p: Provider, stored: Option<&str>) {
        let e = self.settings.providers.entry(p.id().to_string()).or_insert_with(ProviderSettings::default);
        e.stored = stored.map(str::to_string);
    }

    pub fn set_enabled(&mut self, p: Provider, on: bool) {
        if on {
            self.enabled.insert(p);
        } else {
            self.enabled.remove(&p);
        }
        let e = self.settings.providers.entry(p.id().to_string()).or_insert_with(ProviderSettings::default);
        e.enabled = on;
    }

    /// Where the key the next call would use lives, without touching the keystore (R-94):
    /// the session map, then the record of the last keychain store, then a `keys.json` entry
    /// the user re-confirmed at this boot.
    pub fn store_of(&self, p: Provider) -> Option<&'static str> {
        if self.session_keys.contains_key(&p) {
            return Some("session");
        }
        match self.stored(p).as_deref() {
            Some("keychain") => Some("keychain"),
            Some("file") if self.file_ok.contains(&p) => Some("file"),
            _ => None,
        }
    }

    pub fn snapshot(&self) -> CloudState {
        let mut providers = BTreeMap::new();
        for p in Provider::ALL {
            let store = self.store_of(p);
            // A key that would be used: present (R-109: settings.json alone sends nothing).
            // An unconfirmed key file is still reported, so the sheet can offer to delete it.
            let shown = store.map(str::to_string).or_else(|| match self.stored(p).as_deref() {
                Some("file") => Some("file-unconfirmed".to_string()),
                _ => None,
            });
            providers.insert(
                p.id().to_string(),
                ProviderState { enabled: self.on && self.enabled.contains(&p), present: store.is_some(), store: shown },
            );
        }
        CloudState { on: self.on, keystore: self.keystore.clone(), providers, scrubbed: self.scrubbed.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_parse_only_their_ids() {
        for p in Provider::ALL {
            assert_eq!(Provider::parse(p.id()), Some(p));
        }
        for bad in ["", "local", "litellm", "Groq", "groq ", "openai"] {
            assert_eq!(Provider::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_cloud_off_settings_file_enables_nothing() {
        let mut s = Settings::default();
        s.providers.insert("groq".into(), ProviderSettings { enabled: true, stored: Some("keychain".into()) });
        let g = GateState::new(s, vec![]);
        let st = g.snapshot();
        assert!(!st.on);
        assert!(!st.providers["groq"].enabled, "cloudOptIn:false gates every provider");
        assert_eq!(st.keystore, "unknown");
    }

    #[test]
    fn present_needs_a_key_on_this_machine() {
        let mut s = Settings::default();
        s.cloud_opt_in = true;
        s.providers.insert("groq".into(), ProviderSettings { enabled: true, stored: None });
        s.providers.insert("gemini".into(), ProviderSettings { enabled: true, stored: Some("file".into()) });
        let mut g = GateState::new(s, vec!["openrouter".into()]);
        let st = g.snapshot();
        assert!(st.on && st.providers["groq"].enabled && !st.providers["groq"].present);
        assert!(!st.providers["gemini"].present, "a key file is used only after this boot's confirm");
        assert_eq!(st.providers["gemini"].store.as_deref(), Some("file-unconfirmed"));
        assert_eq!(st.scrubbed, vec!["openrouter".to_string()]);
        g.session_keys.insert(Provider::Groq, "test-only-x".into());
        g.file_ok.insert(Provider::Gemini);
        let st = g.snapshot();
        assert_eq!(st.providers["groq"].store.as_deref(), Some("session"));
        assert!(st.providers["gemini"].present && st.providers["gemini"].store.as_deref() == Some("file"));
        let j = serde_json::to_string(&st).unwrap();
        assert!(!j.contains("test-only"), "a CloudState never carries a key");
    }
}
