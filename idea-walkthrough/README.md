# Stagecraft

Turns an idea into a plan. **Quick plan**, the default, is one strong prompt in one call. The full
walkthrough runs eight stages. Each stage declares a power **floor**, and each one is sent to the
cheapest model that clears it. The
goal is the most accurate help available from free models: a stage that runs cheaply and answers
badly has failed.

`index.html` is the whole app: markup, CSS and one inline script, with no dependencies. The
same file ships in two forms:

- **The desktop app** (Tauri 2, in `../desktop/`). v1 runs on local Ollama models only. This is
  the form the project is heading for (decided 2026-11-16). See "The desktop app" below.
- **A plain browser page.** It still works and keeps every provider: OpenRouter, Groq, Google
  AI Studio, a LiteLLM gateway, and local Ollama when the page is served from `localhost`.

## The stages

| # | Stage | Floor | Output status (stamped on it, carried to every later stage) |
|---|---|---|---|
| 1 | Capture | medium | CONTRACT, binding |
| 2 | Diverge | low | PROPOSALS, unvalidated speculation |
| 3 | Structure | medium | ORDERING, not a decision |
| 4 | Deepen | **high** | ANALYSIS, which inherits the status of what it reasons about |
| 5 | Critique | **high** | OBJECTIONS, where severity is conditional on the premise |
| 6 | Reconcile | **high** | AUDIT, which introduces nothing and sees only Capture and Critique |
| 7 | Review | **high** | PLAN, the deliverable: steps to follow, built only from the contract and the objections the audit let stand. Sees only Capture, Critique and Reconcile |
| 8 | Check facts | **high** | CHECK, which lists claims in the plan to verify before relying on them |

In the author's blind grading the walkthrough's best runs scored about the same as Quick plan,
which is why Quick plan is the default.

## Rules it will not break

1. **Verified-only.** A provider or model is usable only after a live call succeeds.
2. **No silent downgrade.** When nothing installed or connected reaches a stage's floor,
   Stagecraft says so before anything is sent and lets you choose. A run below the floor is
   labelled on the destination line, on the receipt, in every later stage's context and in the
   export.
3. **Epistemic status survives every stage boundary.** It is stamped at the join, so a
   proposal never arrives downstream looking like a fact.

Every answer has a receipt: the model, the provider, the tier, the allowance left and, for a
local model, tokens, tokens per second and wall time.

## The desktop app

- **Models:** local Ollama by default, plus free cloud tiers only after you opt in (see
  `../README.md`). The app talks to `http://127.0.0.1:11434` through
  tauri-plugin-http, so no Ollama CORS setup or environment variable is needed. Until you opt
  in, the HTTP scope allows nothing else, so cloud providers cannot be reached, even with a
  stale key on disk.
- **Onboarding:** the Models sheet detects Ollama. If it is not running, the sheet shows how to
  install it for your OS. If it is running, it lists your models, says how many of the
  stages they run at their designed tier, and can pull a suggested model.
- **Honest warnings:** on a typical machine no local model reaches the high tier, so Deepen,
  Critique, Reconcile and Review offer to run below their floor and say what that costs. They also
  warn when a model may not fit in free memory.
- **Saving:** your work is a file the app owns, `state.json` (mode 0600) in
  `~/.local/share/local.stagecraft.desktop/`. Writes are atomic, and the previous good copy is
  kept as `state.json.bak`. The storage line says when the last save landed, and a failed
  save stays on screen.
- **Export:** "Download write-up" opens a native Save dialog. It reports the saved path, and a
  cancel reports that nothing was saved.
- **Ollama install:** Ollama is a separate install. On Linux the official script needs sudo.

Build, test and self-test instructions are in `../desktop/README.md`.

## The browser page

- **Served** (`python3 -m http.server -d idea-walkthrough 8743`, then open
  `http://localhost:8743`): state is kept in that origin's localStorage, and local Ollama
  works, because Ollama accepts `http://localhost:*` origins.
- **Double-clicked** (`file://`): state lives only in that tab's sessionStorage. Chromium
  shares one storage partition across every `file://` document, so a key written there would
  be readable by any other local HTML file. Ollama refuses `file://` pages.
- **Where keys go:** keys stay in that browser, and requests go straight to the provider.
  There is no server, no account and no telemetry. "Forget everything" wipes it all.

## Tests

```bash
cd idea-walkthrough && node --test tests/        # Node 18
```

The tests lift code straight out of `index.html` by text anchors, so they cannot drift from
the shipped page. The `desktop-*.test.js` files cover the desktop section with a mocked
`__TAURI__`, and none of them needs Tauri. Rust unit tests and the live self-test are in
`../desktop/README.md`.
