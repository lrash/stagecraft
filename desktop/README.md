# Stagecraft desktop (Tauri 2)

This app wraps `../idea-walkthrough/index.html` unchanged. The file is embedded by
`build.frontendDist`, with no frontend build, no `package.json` and no bundler. Everything the
desktop adds lives in `src-tauri/`, or in the one "desktop shell (Tauri)" section of the page,
which does nothing in a browser. References like R-12 or §9 point to the author's design notes,
which are not part of this repository.

By default the app is **local Ollama only**. The HTTP scope is five Ollama endpoints on
`127.0.0.1:11434` (version, tags, show, ps, chat; model pulls go through a Rust command) and
the CSP allows only IPC. Free cloud tiers (OpenRouter, Groq, Google AI Studio) are granted at
runtime only after the user opts in (`src-tauri/capabilities-runtime/cloud.json`), and keys
are stored in the OS keychain.

## Build

The prerequisites are Rust (stable), the Tauri CLI 2.12.x and the WebKitGTK 4.1 dev libraries.
Install the CLI pinned with `cargo install tauri-cli --version "^2.12" --locked`. There are no npm
packages.

```sh
cd desktop/src-tauri
cargo build                                   # debug binary: target/debug/stagecraft
cargo test                                    # Rust unit tests
cargo tauri build --bundles appimage,deb      # release bundles under target/release/bundle/
```

`Cargo.lock` is committed. Versions: tauri 2.12.6, tauri-plugin-http 2.9.0 (with
`unsafe-headers`, so an empty `Origin` removes the header), dialog 2.8.4, opener 2.7.3.

## Self-test (DESIGN §9)

The app has a self-test mode, used for unattended checks. It uses the same code path the
app uses: page → fetch shim → plugin-http → Rust reqwest → Ollama.

```sh
STAGECRAFT_SELFTEST=/tmp/st.json STAGECRAFT_DATA_DIR=$(mktemp -d) ./stagecraft
```

Optional variables:

| Variable | Effect |
|---|---|
| `STAGECRAFT_SELFTEST_CHAT=1` | streams "Reply with OK" on the smallest installed model |
| `STAGECRAFT_SELFTEST_STAGE=capture` | runs a full Capture on a fixed idea (30 min watchdog) |
| `STAGECRAFT_SELFTEST_ACTION=forget\|export\|reload\|abort` | drives one flow |
| `STAGECRAFT_SELFTEST_DIALOG=yes\|no\|cancel\|<path>` | answers the confirm and save dialogs |
| `STAGECRAFT_SELFTEST_ECHO=1` | debug builds only: also probes `tests/fixtures/echo-server.js` on 11435 |
| `STAGECRAFT_SELFTEST_OLLAMA=<base>` | debug builds only: points the page at another Ollama, e.g. a closed port |

The app writes the JSON report and exits 0. A watchdog writes `{"timeout":true}` and exits 2.

`desktop/scripts/selftest.sh [binary]` runs the agent-gate set against a binary and prints
PASS/FAIL per acceptance test: A-5, A-8, A-10…A-15, A-17, A-18 and A-21, plus A-6/A-7 on a
debug build.

## Add it to the applications menu (AppImage, no admin)

`scripts/install-launcher.sh` copies the newest AppImage to `~/Applications/Stagecraft.AppImage`,
installs the icons under `~/.local/share/icons`, and writes `~/.local/share/applications/stagecraft.desktop`.
Stagecraft then shows in the applications menu, and you can right-click it there to pin it to the
taskbar. The window's app id is `stagecraft`, so the running window groups under the pinned icon.
Re-run the script after each rebuild to update the copy. `--uninstall` removes the launcher and the
copy, never your ideas. If the `.deb` is also installed, the menu shows Stagecraft twice; keep one.

## Data

- **Location:** `~/.local/share/local.stagecraft.desktop/`, or `$STAGECRAFT_DATA_DIR`.
- **Files:** `state.json`, `state.json.bak` (the previous good save) and `state.json.bad` (an
  unreadable file, kept for you).
- **Permissions:** the directory is 0700 and the files are 0600.

## If the window is blank (WebKitGTK)

Try `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./stagecraft`. On the build box (Ubuntu 24.04, Wayland),
the page ran without it, but nobody has looked at the window yet.

## If the AppImage says libfuse2 is missing

Run it with `--appimage-extract-and-run`, or install the `.deb`, which needs admin.
