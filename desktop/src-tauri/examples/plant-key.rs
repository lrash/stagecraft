//! Dev-only helper for A-62(a) (DESIGN-desktop §13.10): plants a key in the Secret Service the
//! same way the app stores one (keyring-core + the zbus store, service = the bundle identifier,
//! account = the provider id), so the RELEASE binary can be traced with a key stored and cloud
//! off. Run it only inside `dbus-run-session` against a throwaway keyring, never the user's
//! login keyring:
//!   HOME=$(mktemp -d) dbus-run-session -- sh -c 'printf throwaway | gnome-keyring-daemon --login -C "$HOME/kr"; \
//!     gnome-keyring-daemon --start --components=secrets -C "$HOME/kr"; target/debug/examples/plant-key groq "$VALUE"'
//! (`--unlock` with an empty password creates no collection, so the write is refused; a
//! PAM-style `--login` with a throwaway password creates the login keyring.)
//! The value is read from the arguments and never printed.
//!
//! Guards (v2 review), because it writes under the app's real service name: it refuses unless
//! `STAGECRAFT_PLANT_KEY_THROWAWAY` is set to the current `$HOME` (selftest.sh sets it inside the
//! private session, whose HOME is a throwaway directory), unless the session bus is a private one
//! (not the login session's `/run/user/<uid>/bus`), and whenever an entry already exists, so it
//! can never overwrite a real stored key.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: plant-key <openrouter|groq|gemini> <value>");
        std::process::exit(2);
    }
    let (provider, value) = (&args[1], &args[2]);
    if !["openrouter", "groq", "gemini"].contains(&provider.as_str()) || !value.starts_with("test-only-") {
        eprintln!("plant-key: refusing: the provider must be one of the three, and the value must start with test-only-");
        std::process::exit(2);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let bus = std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap_or_default();
    if home.is_empty() || std::env::var("STAGECRAFT_PLANT_KEY_THROWAWAY").ok().as_deref() != Some(home.as_str()) {
        eprintln!("plant-key: refusing: set STAGECRAFT_PLANT_KEY_THROWAWAY to the throwaway $HOME of a private dbus-run-session");
        std::process::exit(2);
    }
    if bus.is_empty() || bus.contains("/run/user/") {
        eprintln!("plant-key: refusing: this is the login session's bus, not a private dbus-run-session one");
        std::process::exit(2);
    }
    #[cfg(target_os = "linux")]
    {
        let store = zbus_secret_service_keyring_store::Store::new().unwrap_or_else(|_| {
            eprintln!("plant-key: no Secret Service on this bus");
            std::process::exit(1)
        });
        let entry = keyring_core::api::CredentialStoreApi::build(&*store, "local.stagecraft.desktop", provider, None).expect("entry");
        if entry.get_password().is_ok() {
            eprintln!("plant-key: refusing: a {provider} entry already exists, and this helper never overwrites one");
            std::process::exit(2);
        }
        entry.set_password(value).unwrap_or_else(|_| {
            eprintln!("plant-key: the store refused the write (locked?)");
            std::process::exit(1)
        });
        println!("plant-key: planted a {provider} entry");
    }
}
