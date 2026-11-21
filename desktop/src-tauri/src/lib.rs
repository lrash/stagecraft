//! Stagecraft desktop (DESIGN-desktop.md). Tauri wraps the unchanged `idea-walkthrough/index.html`;
//! this crate adds only what a page cannot do for itself:
//! - reach local Ollama through tauri-plugin-http (no browser CORS, a strict URL scope);
//! - own the state file (`state.json`, atomic, 0600) and inject it at boot;
//! - a native save dialog for the write-up, and the system browser for links;
//! - model pulls, so `/api/pull` (which dials any registry a name names) is not in the page's scope;
//! - the self-test harness, so the whole path can be checked unattended.
//!
//! The IPC surface is exactly the commands below (R-72), restricted in build.rs and granted in
//! capabilities/main.json (`selftest_report` only through the runtime `selftest` capability).

mod cloud;
mod export;
mod gate;
mod oauth;
mod pull;
mod secrets;
mod selftest;
mod state;

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use cloud::{Cloud, CloudEndpoint, CloudResponse};
use gate::{CloudState, Provider};
use secrets::{KeyCheck, KeyState};

/// Application state shared by the commands.
pub struct Shared {
    data_dir: PathBuf,
    persistent: bool,
    /// The only window generation whose saves are accepted (D-4). A reload bumps it.
    current_gen: AtomicU32,
    loads: Mutex<HashMap<String, u32>>,
    closing: Mutex<HashSet<String>>,
    selftest: Option<selftest::Spec>,
    ollama_base: Option<String>,
    /// The one model pull that may run at a time, so the page can cancel it.
    pull: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// Debug builds only (D-29): every init script and cloud/secret reply sent to the page.
    ipclog: Option<PathBuf>,
}

/// Held for the whole of a write, so two saves can never interleave on disk.
pub struct SaveLock(Mutex<()>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Boot<'a> {
    state: Option<&'a str>,
    persistent: bool,
    state_error: Option<&'a str>,
    os: &'static str,
    arch: &'static str,
    version: String,
    gen: u32,
    selftest: Option<&'a selftest::Spec>,
    keys: serde_json::Map<String, serde_json::Value>, // always empty: keys never reach the page (R-93)
    /// v2 (R-110): built from the live gate, so a replacement window sees the current state.
    cloud: gate::CloudState,
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_base: Option<&'a str>,
    /// v2 (D-4): cloud requests a replaced window had already sent, per provider, for the new
    /// page's ledger. Empty except in the window that replaces a reloaded one.
    cloud_unrecorded: std::collections::BTreeMap<String, u32>,
}

/// The initialization script: an event collector for the self-test (CSP violations and script
/// errors, installed before any page code), then the boot object. Re-runs on every document
/// load with this same content, which is why a reload replaces the window (D-4).
fn init_js(app: &AppHandle, gen: u32, loaded: &state::Loaded) -> String {
    let shared = app.state::<Shared>();
    let boot = Boot {
        state: loaded.state.as_deref(),
        persistent: shared.persistent,
        state_error: loaded.error,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        version: app.package_info().version.to_string(),
        gen,
        selftest: shared.selftest.as_ref(),
        keys: Default::default(),
        cloud: app.state::<Arc<Cloud>>().snapshot(),
        ollama_base: shared.ollama_base.as_deref(),
        cloud_unrecorded: std::mem::take(&mut app.state::<Arc<Cloud>>().lock().unrecorded),
    };
    let json = serde_json::to_string(&boot).unwrap_or_else(|_| "{}".into());
    let js = format!(
        r#"(function(){{
  var ev = {{ csp: [], errors: [] }};
  try {{ Object.defineProperty(window, "__scdEvents", {{ value: ev }}); }} catch (e) {{}}
  document.addEventListener("securitypolicyviolation", function(e){{
    ev.csp.push({{ directive: String(e.violatedDirective), blocked: String(e.blockedURI || ""),
                  sample: String(e.sample || "").slice(0, 120), line: e.lineNumber || 0 }});
  }});
  window.addEventListener("error", function(e){{ ev.errors.push(String(e.message) + " @" + (e.lineno || 0)); }});
  window.addEventListener("unhandledrejection", function(e){{
    var r = e.reason; ev.errors.push("unhandled rejection: " + String((r && r.message) || r));
  }});
  window.__STAGECRAFT_BOOT__ = {json};
}})();"#
    );
    ipclog(&shared, "init", &js);
    js
}

/// D-29: appends what Rust hands the page, so A-40 can grep it for keys. Debug builds only.
fn ipclog(shared: &Shared, what: &str, text: &str) {
    if let Some(p) = &shared.ipclog {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{what}\t{text}");
        }
    }
}

fn logged<T: Serialize>(shared: &Shared, what: &str, r: Result<T, String>) -> Result<T, String> {
    if shared.ipclog.is_some() {
        let text = match &r {
            Ok(v) => serde_json::to_string(v).unwrap_or_default(),
            Err(e) => format!("error: {e}"),
        };
        ipclog(shared, what, &text);
    }
    r
}

/// The window may only ever show the app itself (R-40). Links go to the system browser.
fn app_origin(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

fn label_for(gen: u32) -> String {
    if gen == 1 {
        "main".into()
    } else {
        format!("main-{gen}")
    }
}

fn open_main(app: &AppHandle, gen: u32, loaded: &state::Loaded) -> tauri::Result<WebviewWindow> {
    let handle = app.clone();
    WebviewWindowBuilder::new(app, label_for(gen), WebviewUrl::App("index.html".into()))
        .title("Stagecraft")
        .inner_size(1100.0, 820.0)
        .min_inner_size(420.0, 560.0)
        .initialization_script(init_js(app, gen, loaded))
        .on_navigation(app_origin)
        .on_page_load(move |win, payload| {
            if payload.event() == PageLoadEvent::Started {
                on_load_started(&handle, win, gen);
            }
        })
        .build()
}

/// D-4: the second load of a window would run the page on launch-time state, and its next
/// save would overwrite newer work. So retire that window's generation at once (its saves now
/// bounce) and replace it with a new window booted from what is on disk.
fn on_load_started(app: &AppHandle, win: WebviewWindow, gen: u32) {
    let shared = app.state::<Shared>();
    let n = {
        let mut loads = shared.loads.lock().unwrap_or_else(|e| e.into_inner());
        let c = loads.entry(win.label().to_string()).or_insert(0);
        *c += 1;
        *c
    };
    if n < 2 {
        return;
    }
    if shared.current_gen.compare_exchange(gen, gen + 1, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return; // already replaced
    }
    // The old window's cloud requests end now: their answers would reach no page (v2 review).
    app.state::<Arc<Cloud>>().cancel_label(win.label());
    let app = app.clone();
    std::thread::spawn(move || {
        let loaded = {
            // Wait out any save still landing, then read what it left.
            let lock = app.state::<SaveLock>();
            let _g = lock.0.lock().unwrap_or_else(|e| e.into_inner());
            state::load_scrubbed(&app.state::<Shared>().data_dir).0
        };
        match open_main(&app, gen + 1, &loaded) {
            Ok(_) => {
                let _ = win.destroy();
            }
            Err(e) => eprintln!("stagecraft: could not replace the reloaded window: {e}"),
        }
    });
}

#[tauri::command]
async fn state_save(
    shared: State<'_, Shared>,
    lock: State<'_, SaveLock>,
    json: Option<String>,
    gen: u32,
) -> Result<u64, String> {
    let _g = lock.0.lock().map_err(|_| "the save lock is poisoned".to_string())?;
    if gen != shared.current_gen.load(Ordering::SeqCst) {
        return Err(format!("stale window generation {gen}: this window was reloaded, so its state is out of date"));
    }
    state::save(&shared.data_dir, json.as_deref())
}

#[tauri::command]
async fn save_export(
    app: AppHandle,
    shared: State<'_, Shared>,
    suggested_name: String,
    text: String,
) -> Result<Option<String>, String> {
    let name = export::sanitize_name(&suggested_name);
    let chosen: Option<PathBuf> = match &shared.selftest {
        Some(spec) => match export::selftest_answer(spec.dialog.as_deref().unwrap_or("")) {
            export::DialogAnswer::Cancel => None,
            export::DialogAnswer::Path(p) => Some(p),
        },
        None => match app.dialog().file().set_file_name(&name).add_filter("Markdown", &["md"]).blocking_save_file() {
            None => None,
            Some(fp) => Some(fp.into_path().map_err(|e| format!("that location cannot be saved to: {e}"))?),
        },
    };
    let Some(path) = chosen else { return Ok(None) };
    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SysInfo {
    total_mb: u64,
    avail_mb: u64,
    os: &'static str,
    arch: &'static str,
}

#[tauri::command]
fn sys_info() -> Result<SysInfo, String> {
    let mut s = sysinfo::System::new().map_err(|e| format!("memory information is unavailable: {e}"))?;
    s.refresh_memory();
    Ok(SysInfo {
        total_mb: s.total_memory() / (1024 * 1024),
        avail_mb: s.available_memory() / (1024 * 1024),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    })
}

/// R-66: pull one of the recommended models. Progress and then one `{end}` arrive on `on_event`;
/// the command itself returns as soon as the download has started.
#[tauri::command]
fn ollama_pull(shared: State<'_, Shared>, model: String, on_event: tauri::ipc::Channel<serde_json::Value>) -> Result<(), String> {
    if !pull::allowed(&model) {
        return Err(format!("{model} is not one of the models Stagecraft offers to download"));
    }
    let mut slot = shared.pull.lock().map_err(|_| "the download lock is poisoned".to_string())?;
    if slot.as_ref().is_some_and(|h| !h.inner().is_finished()) {
        return Err("a download is already running".into());
    }
    let base = shared.ollama_base.clone().unwrap_or_else(|| pull::DEFAULT_BASE.to_string());
    *slot = Some(tauri::async_runtime::spawn(pull::run(base, model, on_event)));
    Ok(())
}

/// Cancels the running pull, if any. Ollama keeps what it already downloaded.
#[tauri::command]
fn ollama_pull_cancel(shared: State<'_, Shared>) -> Result<bool, String> {
    let mut slot = shared.pull.lock().map_err(|_| "the download lock is poisoned".to_string())?;
    Ok(match slot.take() {
        Some(h) if !h.inner().is_finished() => {
            h.abort();
            true
        }
        _ => false,
    })
}

#[tauri::command]
fn flush_done(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

#[tauri::command]
fn selftest_report(app: AppHandle, shared: State<'_, Shared>, json: String) -> Result<(), String> {
    let Some(spec) = &shared.selftest else {
        return Err("not in self-test mode".into());
    };
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("the report is not JSON: {e}"))?;
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(&spec.report, pretty).map_err(|e| format!("could not write the report: {e}"))?;
    eprintln!("stagecraft selftest: report written to {}", spec.report.display());
    app.exit(0);
    Ok(())
}

/* ---------- v2: cloud commands (§13.3). The page never holds a key. ---------- */

/// R-84. Plain text: native dialogs show no bold or bullets. A-42 compares both with the design.
pub const OPT_IN_TITLE: &str = "Use free cloud models?";
pub const OPT_IN_TEXT: &str = "With this on, Stagecraft can send a stage to a free cloud service when you choose, or when the models on this computer are below that stage's floor.

What leaves this computer: that stage's prompt, which is your idea plus the earlier stages' write-ups it builds on. You can see exactly what will be sent before a stage first goes to each service. No files, no other ideas.

To whom: only the services you turn on next (OpenRouter, Groq, Google AI Studio). Each may keep what you send and use it under its own terms; the Models sheet says how.

Cost: free on free accounts. If your Groq organisation or Google project has billing turned on, calls may be charged. Each has a daily allowance; when it runs out, that service waits for its reset.

You can keep any idea on this computer. Turning this off stops cloud use at once.";

/// A Rust-owned yes/no. Under the self-test, `…_DIALOG` answers it ONLY in a debug build; a
/// release build always shows the real dialog (R-80, A-63). Blocking.
fn ask_blocking(app: &AppHandle, title: &str, text: &str, yes: &str, no: &str) -> bool {
    #[cfg(debug_assertions)]
    if let Some(d) = app.state::<Shared>().selftest.as_ref().and_then(|s| s.dialog.clone()) {
        // v2 review: `…_DIALOG` answers a Rust ask only against the mock. Without it nothing
        // answers Yes for a person: the ask is declined, so nothing opts in or is written.
        let mock = app.try_state::<Arc<Cloud>>().is_some_and(|c| c.base != cloud::Base::Real);
        if !mock {
            eprintln!("stagecraft selftest: a Rust ask was declined: …_DIALOG answers only with the mock provider");
            return false;
        }
        return d == "yes";
    }
    app.dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
        .blocking_show()
}

async fn ask(app: &AppHandle, title: &'static str, text: String, yes: &'static str, no: &'static str) -> bool {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || ask_blocking(&a, title, &text, yes, no)).await.unwrap_or(false)
}

/// `cloud.json` is added at most once per process (there is no remove, D-25).
fn grant_cloud(app: &AppHandle, cloud: &Cloud) -> Result<(), String> {
    let mut g = cloud.lock();
    if !g.cap_added {
        app.add_capability(include_str!("../capabilities-runtime/cloud.json")).map_err(|e| format!("could not grant cloud use: {e}"))?;
        g.cap_added = true;
    }
    Ok(())
}

/// R-94: at an opted-in boot or right after Yes, only `Store::new()`, off the main thread.
fn probe_keystore(cloud: Arc<Cloud>) {
    std::thread::spawn(move || {
        let st = cloud.ks.probe();
        cloud.lock().keystore = st.into();
        cloud.changed();
    });
}

#[tauri::command]
async fn cloud_enable(app: AppHandle, shared: State<'_, Shared>, cloud: State<'_, Arc<Cloud>>) -> Result<CloudState, String> {
    let r = async {
        if cloud.lock().on {
            return Ok(cloud.snapshot());
        }
        if !ask(&app, OPT_IN_TITLE, OPT_IN_TEXT.into(), "Turn on", "Keep everything local").await {
            return Ok(cloud.snapshot()); // No writes nothing
        }
        grant_cloud(&app, &cloud)?;
        cloud.open_gate();
        let st = cloud.changed();
        probe_keystore(cloud.inner().clone());
        Ok(st)
    }
    .await;
    logged(&shared, "cloud_enable", r)
}

#[tauri::command]
async fn cloud_disable(shared: State<'_, Shared>, cloud: State<'_, Arc<Cloud>>, forget: Option<bool>) -> Result<CloudState, String> {
    let c = cloud.inner().clone();
    let r = tauri::async_runtime::spawn_blocking(move || c.disable(forget.unwrap_or(false))).await.map_err(|e| e.to_string());
    logged(&shared, "cloud_disable", r)
}

#[tauri::command]
async fn cloud_provider_set(shared: State<'_, Shared>, cloud: State<'_, Arc<Cloud>>, provider: String, enabled: bool) -> Result<CloudState, String> {
    let r = match Provider::parse(&provider) {
        None => Err("not-allowed".to_string()),
        Some(p) => cloud.provider_set(p, enabled),
    };
    logged(&shared, "cloud_provider_set", r)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn cloud_fetch(
    webview: tauri::Webview,
    shared: State<'_, Shared>,
    cloud: State<'_, Arc<Cloud>>,
    scope: tauri::ipc::CommandScope<CloudEndpoint>,
    req_id: u32,
    provider: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<CloudResponse, String> {
    let ok = |row: &cloud::Row| {
        scope.allows().iter().any(|e| e.matches(row)) && !scope.denies().iter().any(|e| e.matches(row))
    };
    let r = cloud.inner().fetch(webview.label(), req_id, &provider, &method, &path, body, &ok).await;
    logged(&shared, "cloud_fetch", r)
}

#[tauri::command]
fn cloud_fetch_cancel(webview: tauri::Webview, shared: State<'_, Shared>, cloud: State<'_, Arc<Cloud>>, req_id: u32) -> Result<bool, String> {
    logged(&shared, "cloud_fetch_cancel", Ok(cloud.cancel(webview.label(), req_id)))
}

#[tauri::command]
async fn secret_set(
    app: AppHandle,
    shared: State<'_, Shared>,
    cloud: State<'_, Arc<Cloud>>,
    provider: String,
    value: String,
    store: Option<String>,
) -> Result<KeyCheck, String> {
    let a = app.clone();
    let path = cloud.dir.join(state::KEYS_FILE).display().to_string();
    // R-94: asked on every file write, for each provider; never automatic.
    let confirm = Box::new(move || {
        ask_blocking(
            &a,
            "Stagecraft",
            &format!("The key will be written unencrypted to {path}. Any program running as you can read it, and anyone with a copy can use your free allowance. Save it?"),
            "Save it unencrypted",
            "Cancel",
        )
    });
    let r = cloud.inner().secret_set(&provider, &value, store.as_deref(), confirm).await;
    logged(&shared, "secret_set", r)
}

/// "Sign in with OpenRouter" (2026-11-18): opens openrouter.ai in the system browser, waits up
/// to five minutes for its loopback callback, trades the code for a key in Rust, and stores it in
/// the keychain like a pasted key. The page gets only the KeyCheck, never the code or the key.
#[tauri::command]
async fn openrouter_sign_in(app: AppHandle, shared: State<'_, Shared>, cloud: State<'_, Arc<Cloud>>) -> Result<KeyCheck, String> {
    let r = openrouter_sign_in_inner(&app, cloud.inner()).await;
    logged(&shared, "openrouter_sign_in", r)
}
static SIGNING_IN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
async fn openrouter_sign_in_inner(app: &AppHandle, cloud: &Arc<Cloud>) -> Result<KeyCheck, String> {
    // One sign-in at a time: a second click must not mint a second key (security review).
    if SIGNING_IN.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            SIGNING_IN.store(false, Ordering::SeqCst);
        }
    }
    let _done = Done;
    openrouter_sign_in_once(app, cloud).await
}
async fn openrouter_sign_in_once(app: &AppHandle, cloud: &Arc<Cloud>) -> Result<KeyCheck, String> {
    use tauri_plugin_opener::OpenerExt;
    cloud.check_gate(Provider::Openrouter)?;
    cloud.keychain_ready().await?;   // before the browser opens: never mint a key we cannot keep
    let p = oauth::pkce().map_err(str::to_string)?;
    let (listeners, port) = oauth::listen().map_err(str::to_string)?;
    app.opener().open_url(oauth::auth_url(port, &p), None::<&str>).map_err(|_| "open-failed".to_string())?;
    let state = p.state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        oauth::wait_for_code(&listeners, &state, std::time::Instant::now() + oauth::WAIT, &|| false)
    })
    .await
    .map_err(|_| "error".to_string())?
    .map_err(str::to_string)?;
    let key = cloud.openrouter_exchange(&code, &p.verifier).await?;
    cloud.secret_set("openrouter", &key, Some("keychain"), Box::new(|| false)).await
}

#[tauri::command]
async fn secret_has(shared: State<'_, Shared>, cloud: State<'_, Arc<Cloud>>, provider: String) -> Result<KeyState, String> {
    let r = Provider::parse(&provider).map(|p| secrets::has(&cloud.gate, p)).ok_or_else(|| "not-allowed".to_string());
    logged(&shared, "secret_has", r)
}

#[tauri::command]
async fn secret_delete(shared: State<'_, Shared>, cloud: State<'_, Arc<Cloud>>, provider: String) -> Result<CloudState, String> {
    let r = match Provider::parse(&provider) {
        None => Err("not-allowed".to_string()),
        Some(p) => {
            let c = cloud.inner().clone();
            match tauri::async_runtime::spawn_blocking(move || secrets::delete(&c.ks, &c.dir, &c.gate, p)).await {
                Ok(Ok(())) => Ok(cloud.changed()),
                Ok(Err(e)) => {
                    cloud.changed();
                    Err(e)
                }
                Err(e) => Err(e.to_string()),
            }
        }
    };
    logged(&shared, "secret_delete", r)
}

/// R-109: a `keys.json` key is used only after a Rust ask at each opted-in boot.
fn reconfirm_key_files(app: &AppHandle, cloud: &Arc<Cloud>) {
    let files: Vec<Provider> = {
        let g = cloud.lock();
        Provider::ALL.into_iter().filter(|p| g.stored(*p).as_deref() == Some("file")).collect()
    };
    if files.is_empty() {
        return;
    }
    let (app, cloud) = (app.clone(), cloud.clone());
    std::thread::spawn(move || {
        let path = cloud.dir.join(state::KEYS_FILE).display().to_string();
        for p in files {
            let msg = format!("Stagecraft is using an unencrypted key file for {} ({path}). Use it this session?", p.name());
            if ask_blocking(&app, "Stagecraft", &msg, "Use it", "Not now") {
                cloud.lock().file_ok.insert(p);
            }
        }
        cloud.changed();
    });
}

/// Debug builds only (D-26): `…_KEYS=<provider>:<value>,…` feeds each value through the
/// `secret_set` path at an opted-in boot (probe against the mock, then store), so live tests
/// get a key into Rust without the page ever holding it.
#[cfg(debug_assertions)]
fn selftest_keys(app: &AppHandle, cloud: &Arc<Cloud>) {
    let Ok(list) = std::env::var("STAGECRAFT_SELFTEST_KEYS") else { return };
    if !cloud.lock().on {
        eprintln!("stagecraft selftest: test keys ignored: this data directory has not opted in");
        return;
    }
    // <provider>:<value> or <provider>:<keychain|session|file>:<value>
    for item in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let Some((pid, rest)) = item.split_once(':') else { continue };
        let Some(p) = Provider::parse(pid) else { continue };
        let (store, value) = match rest.split_once(':') {
            Some((st @ ("keychain" | "session" | "file"), v)) => (Some(st), v),
            _ => (None, rest),
        };
        cloud.lock().set_enabled(p, true);
        let a = app.clone();
        let path = cloud.dir.join(state::KEYS_FILE).display().to_string();
        let confirm = Box::new(move || ask_blocking(&a, "Stagecraft", &format!("The key will be written unencrypted to {path}. Save it?"), "Save", "Cancel"));
        let r = tauri::async_runtime::block_on(cloud.secret_set(pid, value, store, confirm));
        eprintln!("stagecraft selftest: test key for {pid}: {}", r.map(|k| k.status).unwrap_or_else(|e| e));
    }
    cloud.changed();
}

fn data_dir(app: &AppHandle) -> PathBuf {
    if let Some(d) = std::env::var_os("STAGECRAFT_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".stagecraft"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SaveLock(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![state_save, save_export, sys_info, flush_done, ollama_pull, ollama_pull_cancel, selftest_report, cloud_enable, cloud_disable, cloud_provider_set, cloud_fetch, cloud_fetch_cancel, secret_set, secret_has, secret_delete, openrouter_sign_in])
        .on_window_event(|window, event| {
            // Close protocol: hold the close, let the page flush its last save, then close.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let first = window
                    .state::<Shared>()
                    .closing
                    .lock()
                    .map(|mut c| c.insert(window.label().to_string()))
                    .unwrap_or(true);
                if first {
                    let _ = window.emit("scd-flush", window.label());
                    let w = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(3));
                        let _ = w.destroy(); // the page did not answer in time
                    });
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = data_dir(&handle);
            if let Err(e) = state::prepare_dir(&dir) {
                eprintln!("stagecraft: data directory {} is not usable: {e}", dir.display());
            }
            // R-95: keys planted in state.json (or its .bak) are deleted before the page boots.
            let (loaded, scrubbed) = state::load_scrubbed(&dir);
            let persistent = state::canary(&dir);
            let settings = state::load_settings(&dir);
            let opted_in = settings.cloud_opt_in;
            let spec = selftest::Spec::from_env();
            let (base, fail_closed) = selftest::cloud_base();
            if spec.is_some() && opted_in && base == cloud::Base::Real {
                // The self-test never runs against real providers (§13.8, A-5/A-18 probe).
                let report = spec.as_ref().map(|s| s.report.clone()).unwrap_or_default();
                let _ = std::fs::write(&report, br#"{"refused":"this data directory has opted in to cloud use; the self-test runs only against the mock provider"}"#);
                eprintln!("stagecraft selftest: refused: opted-in data directory without a mock provider");
                std::process::exit(3);
            }
            let identifier = handle.config().identifier.clone();
            let cloud = Arc::new(Cloud::new(
                gate::GateState::new(settings, scrubbed),
                secrets::Keystore::new(secrets::Mode::from_env(), &identifier),
                dir.clone(),
                base,
                fail_closed,
                &handle.package_info().version.to_string(),
            ));
            {
                let h = handle.clone();
                *cloud.emit.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(move |st: &CloudState| {
                    let _ = h.emit("stagecraft://cloud", st);
                    if let Some(sh) = h.try_state::<Shared>() {
                        ipclog(&sh, "event", &serde_json::to_string(st).unwrap_or_default());
                    }
                }));
            }
            app.manage(cloud.clone());
            if let Some(s) = &spec {
                app.add_capability(include_str!("../capabilities-runtime/selftest.json"))?;
                selftest::start_watchdog(s);
            }
            let ollama_base = selftest::ollama_override();
            #[cfg(debug_assertions)]
            if spec.as_ref().is_some_and(|s| s.echo.is_some()) || ollama_base.is_some() {
                app.add_capability(include_str!("../capabilities-runtime/echo-dev.json"))?;
            }
            app.manage(Shared {
                data_dir: dir,
                persistent,
                current_gen: AtomicU32::new(1),
                loads: Mutex::new(HashMap::new()),
                closing: Mutex::new(HashSet::new()),
                selftest: spec,
                ollama_base,
                pull: Mutex::new(None),
                ipclog: selftest::ipclog_path(),
            });
            if opted_in {
                grant_cloud(&handle, &cloud).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
                #[cfg(debug_assertions)]
                selftest_keys(&handle, &cloud);
            }
            open_main(&handle, 1, &loaded)?;
            if opted_in {
                // After the window shows: Store::new() only, then this boot's key-file asks.
                if cloud.lock().keystore == "unknown" {
                    probe_keystore(cloud.clone());
                }
                reconfirm_key_files(&handle, &cloud);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Stagecraft");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_app_origin_is_navigable() {
        let ok = ["tauri://localhost/index.html", "http://tauri.localhost/index.html", "https://tauri.localhost/"];
        let bad = [
            "https://ollama.com/download",
            "http://127.0.0.1:11434/",
            "https://tauri.localhost.evil.com/",
            "tauri://evil/",
            "file:///etc/passwd",
            "data:text/html,hi",
            "javascript:alert(1)",
        ];
        for u in ok {
            assert!(app_origin(&Url::parse(u).unwrap()), "{u}");
        }
        for u in bad {
            assert!(!app_origin(&Url::parse(u).unwrap()), "{u}");
        }
    }

    #[test]
    fn labels_follow_generations() {
        assert_eq!(label_for(1), "main");
        assert_eq!(label_for(3), "main-3");
    }

    #[test]
    fn build_rs_commands_match_the_handler() {
        let build = include_str!("../build.rs");
        let lib = include_str!("lib.rs");
        let handler = lib.split("generate_handler![").nth(1).unwrap().split(']').next().unwrap();
        let mut h: Vec<&str> = handler.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        let list = build.split(".commands(&[").nth(1).unwrap().split(']').next().unwrap();
        let mut b: Vec<&str> = list.split(',').map(|s| s.trim().trim_matches('"')).filter(|s| !s.is_empty()).collect();
        h.sort();
        b.sort();
        assert_eq!(h, b, "build.rs command list == generate_handler! list (R-72)");
    }

    #[test]
    fn v1_capabilities_are_least_privilege() {
        let main: serde_json::Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let text = include_str!("../capabilities/main.json");
        assert!(!text.contains("remote"), "no remote URLs (R-43)");
        for bad in ["\"shell:", "\"fs:", "\"process:", "\"store:", "updater"] {
            assert!(!text.contains(bad), "{bad} must not be granted");
        }
        let http = main["permissions"].as_array().unwrap().iter().find(|p| p["identifier"] == "http:default").unwrap();
        let urls: Vec<&str> = http["allow"].as_array().unwrap().iter().map(|u| u["url"].as_str().unwrap()).collect();
        let want: Vec<String> = ["version", "tags", "show", "ps", "chat"].iter().map(|p| format!("http://127.0.0.1:11434/api/{p}")).collect();
        assert_eq!(urls, want, "R-32: exactly the endpoints the page reads, no wildcard");
        assert!(!urls.iter().any(|u| u.contains('*') || u.contains("pull") || u.contains("delete") || u.contains("push") || u.contains("create")));
        for cmd in ["allow-ollama-pull", "allow-ollama-pull-cancel"] {
            assert!(main["permissions"].as_array().unwrap().iter().any(|p| p == cmd), "{cmd} granted");
        }
        assert!(!text.contains("allow-selftest-report"), "selftest_report is runtime-only");
        for f in [include_str!("../capabilities-runtime/selftest.json"), include_str!("../capabilities-runtime/echo-dev.json")] {
            for bad in ["\"shell:", "\"fs:", "\"process:", "\"store:", "remote"] {
                assert!(!f.contains(bad));
            }
        }
    }

    #[test]
    fn config_pins_the_csp_and_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], "local.stagecraft.desktop");
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("connect-src ipc: http://ipc.localhost;"), "R-42: no model host in connect-src");
        assert!(!csp.contains("11434"));
        assert!(conf["app"]["security"].get("useHttpsScheme").is_none(), "D-14");
        assert_eq!(conf["app"]["withGlobalTauri"], true);
        assert_eq!(conf["build"]["frontendDist"][0], "../../idea-walkthrough/index.html");
    }

    #[test]
    fn devtools_feature_is_never_enabled() {
        assert!(!include_str!("../Cargo.toml").contains("devtools"), "R-79");
    }
    #[test]
    fn a42_the_opt_in_dialog_is_the_design_text_exactly() {
        // The design notes are not in the public repository, so R-84's title and text block are
        // copied here verbatim from DESIGN-desktop.md (wrapped as in the design).
        const DESIGN_TITLE: &str = "Use free cloud models?";
        const DESIGN_BLOCK: &str = r#"    With this on, Stagecraft can send a stage to a free cloud service when you choose, or when
    the models on this computer are below that stage's floor.

    What leaves this computer: that stage's prompt, which is your idea plus the earlier stages'
    write-ups it builds on. You can see exactly what will be sent before a stage first goes to
    each service. No files, no other ideas.

    To whom: only the services you turn on next (OpenRouter, Groq, Google AI Studio). Each may
    keep what you send and use it under its own terms; the Models sheet says how.

    Cost: free on free accounts. If your Groq organisation or Google project has billing turned
    on, calls may be charged. Each has a daily allowance; when it runs out, that service waits
    for its reset.

    You can keep any idea on this computer. Turning this off stops cloud use at once.
    "#;
        assert_eq!(OPT_IN_TITLE, DESIGN_TITLE);
        let block = DESIGN_BLOCK;
        // The design wraps lines at ~95 columns for the page; the dialog unwraps them.
        let paras: Vec<String> = block
            .split("\n\n")
            .map(|p| p.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" "))
            .filter(|p| !p.is_empty())
            .collect();
        assert_eq!(OPT_IN_TEXT, paras.join("\n\n"));
        assert!(!OPT_IN_TEXT.contains("**") && !OPT_IN_TEXT.contains("needs"), "plain text, no 'needs' wording");
    }

    fn capability(text: &str) -> tauri_utils::acl::capability::Capability {
        let mut v: serde_json::Value = serde_json::from_str(text).unwrap();
        v.as_object_mut().unwrap().remove("$schema");
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a53_cloud_and_main_resolve_against_the_built_acl() {
        use tauri_utils::acl::{manifest::Manifest, resolved::Resolved};
        let acl: std::collections::BTreeMap<String, Manifest> =
            serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/gen/schemas/acl-manifests.json")).unwrap()).unwrap();
        for (name, text) in [("main", include_str!("../capabilities/main.json")), ("cloud", include_str!("../capabilities-runtime/cloud.json")),
                             ("selftest", include_str!("../capabilities-runtime/selftest.json"))] {
            let mut caps = std::collections::BTreeMap::new();
            caps.insert(name.to_string(), capability(text));
            let r = Resolved::resolve(&acl, caps, tauri_utils::platform::Target::current());
            assert!(r.is_ok(), "{name} resolves (add_capability would otherwise panic): {:?}", r.err());
        }
        // cloud.json's inline scope reaches the cloud_fetch command, and equals ENDPOINTS
        let mut caps = std::collections::BTreeMap::new();
        caps.insert("cloud".to_string(), capability(include_str!("../capabilities-runtime/cloud.json")));
        let r = Resolved::resolve(&acl, caps, tauri_utils::platform::Target::current()).unwrap();
        let cmd = &r.allowed_commands["cloud_fetch"][0];
        let scope = &r.command_scope[&cmd.scope_id.expect("cloud_fetch has a scope id")];
        let mut got: Vec<CloudEndpoint> = scope.allow.iter().map(|v| serde_json::from_value(serde_json::to_value(v).unwrap()).unwrap()).collect();
        let mut want: Vec<CloudEndpoint> = cloud::ENDPOINTS
            .iter()
            .map(|e| CloudEndpoint { provider: e.provider.id().into(), method: e.method.into(), path: e.path.into() })
            .collect();
        got.sort_by(|a, b| (&a.provider, &a.path, &a.method).cmp(&(&b.provider, &b.path, &b.method)));
        want.sort_by(|a, b| (&a.provider, &a.path, &a.method).cmp(&(&b.provider, &b.path, &b.method)));
        assert_eq!(got, want, "the cloud.json scope is the endpoint table");
        for c in ["cloud_fetch_cancel", "cloud_provider_set", "secret_set"] {
            assert!(r.allowed_commands.contains_key(c), "{c}");
        }
        assert!(!r.allowed_commands.contains_key("cloud_enable"), "cloud.json grants only the networked commands");
    }

    #[test]
    fn d25_main_json_adds_only_the_four_offline_cloud_commands() {
        let main: serde_json::Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let text = include_str!("../capabilities/main.json");
        for host in ["openrouter", "groq", "googleapis", "aistudio"] {
            assert!(!text.contains(host), "no cloud host in main.json: {host}");
        }
        let cloudish: Vec<&str> = main["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str())
            .filter(|p| p.contains("cloud") || p.contains("secret")).collect();
        assert_eq!(cloudish, vec!["allow-cloud-enable", "allow-cloud-disable", "allow-secret-has", "allow-secret-delete"]);
        let cloud = include_str!("../capabilities-runtime/cloud.json");
        for bad in ["\"shell:", "\"fs:", "\"process:", "\"store:", "\"http:", "remote", "allow-cloud-enable", "allow-cloud-disable"] {
            assert!(!cloud.contains(bad), "{bad}");
        }
        let v: serde_json::Value = serde_json::from_str(cloud).unwrap();
        let opener = v["permissions"].as_array().unwrap().iter().find(|p| p["identifier"] == "opener:allow-open-url").unwrap();
        let urls: Vec<&str> = opener["allow"].as_array().unwrap().iter().map(|u| u["url"].as_str().unwrap()).collect();
        assert_eq!(urls, vec!["https://openrouter.ai/keys", "https://console.groq.com/keys", "https://aistudio.google.com/apikey"]);
        let page = include_str!("../../../idea-walkthrough/index.html");
        for u in &urls {
            assert!(page.contains(&format!("signup: \"{u}\"")), "the opener scope is exactly the page's signup values: {u}");
        }
    }
}
