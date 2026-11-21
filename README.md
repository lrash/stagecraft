# Stagecraft

Stagecraft turns a rough idea into a plan you can start on today, using AI models that are free
or already on your computer. It is built for accuracy: it says which model answered, says when a
model is below the strength a step needs, and lists the facts you should check before relying on
the plan.

## Two ways to plan

- **Quick plan** (the default): one carefully written prompt, one call to a model. In the author's
  blind tests (three ideas, two judges per answer, scored out of 15) it scored 13.58 on a free
  cloud model, against 13.83 for the best runs of the full walkthrough and 11.0 for a plain
  prompt, at about a tenth of the calls.
- **The full walkthrough**: eight stages (Capture, Diverge, Structure, Deepen, Critique,
  Reconcile, Review, Check facts). Each stage has a minimum model strength and goes to the
  cheapest model that meets it. It is slower, and shows its working.

You can also copy the Quick plan prompt into an AI you already pay for (ChatGPT, Gemini,
Copilot) and paste the answer back. Stagecraft sends nothing on that route.

## Where your words go

- **On this computer** through [Ollama](https://ollama.com), which is the default. Nothing leaves
  the machine.
- **Free cloud tiers**, only after you switch them on: OpenRouter (including "Sign in with
  OpenRouter"), Groq and Google AI Studio. Keys are kept in the operating system's keychain.
  Before anything is sent, Stagecraft names the provider and keeps a ledger of the requests it
  has made.

There is no Stagecraft server, account or telemetry.

## What's here

| Folder | What it is |
|---|---|
| `idea-walkthrough/` | The whole app as one HTML file (`index.html`, no dependencies) and its Node tests |
| `desktop/` | The Tauri 2 desktop app that wraps that file, with keychain storage, file saving and the network allow-list |

## Run it

- **Browser:** `python3 -m http.server -d idea-walkthrough 8743`, then open
  `http://localhost:8743`.
- **Desktop app (Linux):** see [desktop/README.md](desktop/README.md) for building the AppImage
  or .deb.

## Tests

```bash
cd idea-walkthrough && node --test tests/          # Node 18 or later
cd desktop/src-tauri && cargo test                  # Rust unit tests
```

## Status

This is a personal project. It has been built and tested on Linux. The README files in the two
folders go into more detail, and some of them refer to design notes and grading notes that are
not part of this repository.

## License

See [LICENSE](LICENSE).
