#!/usr/bin/env bash
# Runs the DESIGN-desktop §9 self-test set against a built Stagecraft binary or AppImage, and
# prints PASS/FAIL per acceptance test. Needs a display, local Ollama on 127.0.0.1:11434 with at
# least one chat model, python3 and node. Each run uses its own throwaway data directory.
#   desktop/scripts/selftest.sh [path/to/stagecraft]      (default: the release binary)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
BIN="${1:-$REPO/desktop/src-tauri/target/release/stagecraft}"
[ -x "$BIN" ] || { echo "not executable: $BIN" >&2; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/stagecraft-selftest.XXXXXX")"
export DISPLAY="${DISPLAY:-:0}"
FAILS=0
case "$BIN" in */debug/*) DEBUG=1 ;; *) DEBUG=0 ;; esac

run(){  # run <name> <datadir> [VAR=value ...]
  local name="$1" dir="$2"; shift 2
  env STAGECRAFT_SELFTEST="$WORK/$name.json" STAGECRAFT_DATA_DIR="$dir" "$@" \
    timeout 900 "$BIN" >"$WORK/$name.out" 2>"$WORK/$name.err"
  echo $? >"$WORK/$name.exit"
}
check(){  # check <A-id> <python expression over r (report), x (exit code), W (work dir)> [report name]
  local id="$1" expr="$2" name="${3:-$1}"
  if python3 - "$WORK" "$name" "$expr" <<'PY'
import json, os, sys, hashlib, re
W, name, expr = sys.argv[1], sys.argv[2], sys.argv[3]
def strip(t, allow):                       # R-82: the cloud-off allow-list, removed before A-21's grep
    for a in sorted(allow or [], key=len, reverse=True): t = t.replace(a, "")
    return t
def mock(n):                               # the D-26 mock's log for one test, one dict per line
    try: return [json.loads(l) for l in open(os.path.join(W, n + ".mock.log")) if l.strip()]
    except Exception: return []
def chats(n): return [l for l in mock(n) if l.get("kind") == "chat"]
def err(n):
    try: return open(os.path.join(W, n + ".err")).read()
    except Exception: return ""
def grepc(pattern, *paths):
    c = 0
    for p in paths:
        try: c += open(p, errors="replace").read().count(pattern)
        except Exception: pass
    return c
x = int(open(os.path.join(W, name + ".exit")).read().strip() or "99")
try: r = json.load(open(os.path.join(W, name + ".json")))
except Exception: r = {}
ok = False
try: ok = bool(eval(expr))
except Exception as e: print("   error:", e)
sys.exit(0 if ok else 1)
PY
  then echo "PASS  $id"; else echo "FAIL  $id   ($expr)"; FAILS=$((FAILS+1)); fi
}

# A-5 / A-6a / A-10 / A-11: plain boot against the real Ollama
mkdir -p "$WORK/d5"; run A-5 "$WORK/d5"
curl -s -m 8 http://127.0.0.1:11434/api/tags >"$WORK/tags.json" || true
check A-5  'x == 0 and r.get("inTauri") is True and r.get("bootSeen") is True'
# A-30 (R-6): the AppImage runs as a normal (non-root) user, exits 0, and asks for no admin rights
case "$BIN" in *.AppImage)
  check A-30 'os.getuid() != 0 and x == 0 and r.get("inTauri") is True and not re.search(r"\bsudo\b|pkexec|polkit|authentication is required", err("A-5"), re.I)' A-5
;; esac
check A-6a 'r["ollama"]["version"] and sorted(m["id"] for m in r["ollama"]["models"]) == sorted(m["name"] for m in json.load(open(W+"/tags.json"))["models"] if not re.search(r"guard|safety|moderation|embed|rerank|whisper|tts|speech|transcri|lyria|imagen|dall|flux|stable-diffusion|video|veo|sora|music|audio|vision-only|ocr", m["name"], re.I) and not (m.get("remote_host") or m.get("remote_model") or re.search(r"(^|[:-])cloud$", m["name"], re.I)))' A-5
check A-6c 'not any(re.search(r"(^|[:-])cloud$", m["id"], re.I) for m in r["ollama"]["models"])' A-5
check A-27b '"not allowed" in r["scope"]["pullUrl"]["error"] and "not allowed" in r["scope"]["deleteUrl"]["error"] and r["scope"]["pullName"].startswith("refused")' A-5
check A-10 'r["bootSeen"] is True' A-5
check A-11 'r["csp"] == [] and r["errors"] == [] and "fatal" not in r' A-5
check A-19 'len(r["coverage"]) == 6 and "of 6" in r["sheet"]' A-5
check A-21 'not re.search(r"OpenRouter|cloud|free tier|API key|Get a free key|browser|this address|serve from localhost", strip(r["sheet"]+r["notices"]+r["storageNote"], r.get("cloudOffAllow")), re.I) and r["cloud"]["state"]["on"] is False' A-5

# A-8: a streamed chat, then Stop mid-stream followed by a second chat
mkdir -p "$WORK/d8"; run A-8 "$WORK/d8" STAGECRAFT_SELFTEST_CHAT=1
check A-8  'r["chat"]["ok"] and r["chat"]["tokens"] > 0 and r["chat"]["tokPerSec"] > 0 and r["chat"]["firstChunkMs"] < r["chat"]["totalMs"] and r["chat"]["progressUpdates"] >= 2'
run A-8b "$WORK/d8" STAGECRAFT_SELFTEST_ACTION=abort
check A-8b 'r["action"]["result"] == "stopped" and r["action"]["second"]["ok"] and r["action"]["second"]["firstChunkMs"] < 30000'

# A-12: a read-only data directory
mkdir -p "$WORK/d12"; chmod 500 "$WORK/d12"; run A-12 "$WORK/d12"; chmod 700 "$WORK/d12"
check A-12 'r["persistent"] is False and r["storageNote"].startswith("Not saving") and "could not save to disk" in r["notices"]'

# A-13: (a) two runs share state, private modes; (b) reload; (c) corrupt state.json, good .bak
mkdir -p "$WORK/d13"; run A-13a1 "$WORK/d13"; run A-13a2 "$WORK/d13"
check A-13a 'r["previousMarker"] == json.load(open(W+"/A-13a1.json"))["marker"] and oct(os.stat(W+"/d13").st_mode & 0o777) == "0o700" and all(oct(os.stat(W+"/d13/"+f).st_mode & 0o777) == "0o600" for f in os.listdir(W+"/d13"))' A-13a2
run A-13b "$WORK/d13" STAGECRAFT_SELFTEST_ACTION=reload
check A-13b 'x == 0 and r["gen"] == 2 and r["previousMarker"] and r["action"]["result"].startswith("rejected")' A-13b
mkdir -m 700 "$WORK/d13c"; printf '{"idea":"good backup","outputs":{}}' >"$WORK/d13c/state.json.bak"; printf '{"idea":"trunc' >"$WORK/d13c/state.json"
BAK=$(sha256sum "$WORK/d13c/state.json.bak" | cut -d' ' -f1); run A-13c "$WORK/d13c"
check A-13c "r['stateError'] == 'restored-from-bak' and 'restored the one before it' in r['notices'] and os.path.exists(W+'/d13c/state.json.bad') and hashlib.sha256(open(W+'/d13c/state.json.bak','rb').read()).hexdigest() == '$BAK'" A-13c

# A-17 then A-14: forget, answered no, then yes
mkdir -p "$WORK/d14"; run seed "$WORK/d14"; run seed2 "$WORK/d14"
run A-17 "$WORK/d14" STAGECRAFT_SELFTEST_ACTION=forget STAGECRAFT_SELFTEST_DIALOG=no
check A-17 'r["action"]["result"] == "kept" and os.path.exists(W+"/d14/state.json")'
run A-14 "$WORK/d14" STAGECRAFT_SELFTEST_ACTION=forget STAGECRAFT_SELFTEST_DIALOG=yes
check A-14 'r["action"]["result"] == "forgotten" and not os.path.exists(W+"/d14/state.json") and not os.path.exists(W+"/d14/state.json.bak")'
run A-14next "$WORK/d14"
check A-14next 'r["previousMarker"] is None'

# A-15: export to a path, then a cancelled export
run A-15 "$WORK/d14" STAGECRAFT_SELFTEST_ACTION=export STAGECRAFT_SELFTEST_DIALOG="$WORK/x.md"
check A-15 'r["action"]["result"] == "saved" and hashlib.sha256(open(W+"/x.md","rb").read()).hexdigest() == r["action"]["buildMdSha256"] and W+"/x.md" in r["action"]["notices"]'
run A-15c "$WORK/d14" STAGECRAFT_SELFTEST_ACTION=export STAGECRAFT_SELFTEST_DIALOG=cancel
check A-15c 'r["action"]["result"] == "cancelled" and "Nothing was saved" in r["action"]["notices"] and r["action"]["exportedStages"] == r["action"]["exportedStagesBefore"]'

# A-18: a planted OpenRouter key and models never route
mkdir -m 700 "$WORK/d18"
printf '%s' '{"keys":{"openrouter":"sk-or-v1-planted"},"models":{"openrouter":[{"id":"meta-llama/llama-3.3-70b-instruct:free","tier":"high"}]},"stage":0,"idea":"","outputs":{}}' >"$WORK/d18/state.json"
run A-18 "$WORK/d18"
check A-18 '"OpenRouter" not in r["sheet"] and all(c.startswith("local/") for c in r["candidates"]["high"] + r["candidates"]["low"]) and r["probes"][0]["ok"] is False and "not allowed" in r["probes"][0]["error"]'

# v2 test keys: generated per run, never printed, sent only to the mock on 127.0.0.1
key(){ printf 'test-only-%s-%s' "$1" "$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"; }
KG=$(key groq); KO=$(key openrouter); KM=$(key gemini)

if [ "$DEBUG" = 1 ]; then
  # A-6b: the echo server sees no Origin header, and an abort is an AbortError
  node "$REPO/idea-walkthrough/tests/fixtures/echo-server.js" 11435 >"$WORK/echo.log" 2>/dev/null & EP=$!
  sleep 1; mkdir -p "$WORK/d6"; run A-6b "$WORK/d6" STAGECRAFT_SELFTEST_ECHO=1; kill $EP 2>/dev/null
  check A-6b 'r["probes"][1]["ok"] and r["probes"][2]["error"] == "AbortError" and all(not json.loads(l)["hasOrigin"] for l in open(W+"/echo.log") if l.startswith("{"))'
  # A-7: nothing listening
  mkdir -p "$WORK/d7"; S0=$(date +%s); run A-7 "$WORK/d7" STAGECRAFT_SELFTEST_OLLAMA=http://127.0.0.1:11435
  check A-7  "x == 0 and r['ollama']['version'] is None and r['onboarding'] == 'S0' and $(( $(date +%s) - S0 )) <= 15"

  # ---------------- v2 (DESIGN §13.10), debug build, against the D-26 mock only ----------------
  # Test keys are generated per run, never printed, and only ever sent to the mock on 127.0.0.1.
  MP=11620; MOCKJS="$REPO/idea-walkthrough/tests/fixtures/mock-cloud.js"; MPID=""
  mock_start(){ mock_stop; MOCK_LOG="$WORK/$1.mock.log" node "$MOCKJS" $MP >/dev/null 2>&1 & MPID=$!
                for _ in $(seq 50); do curl -s -m 1 "127.0.0.1:$MP/__ping" >/dev/null && break; sleep 0.1; done; }
  mock_stop(){ [ -n "$MPID" ] && kill "$MPID" 2>/dev/null; wait "$MPID" 2>/dev/null; MPID=""; }
  mode(){ local o=null; [ -n "${3:-}" ] && o="\"$3\""
          curl -s -m 2 -XPOST -d "{\"provider\":\"$1\",\"mode\":\"$2\",\"only\":$o}" "127.0.0.1:$MP/__mode" >/dev/null; }
  optin(){ local d="$1"; shift; mkdir -p -m 700 "$d"; local ps=""; for p in "$@"; do ps="$ps${ps:+,}\"$p\":{\"enabled\":true}"; done
           printf '{"v":2,"cloudOptIn":true,"providers":{%s}}' "$ps" >"$d/settings.json"; chmod 600 "$d/settings.json"; }
  V2=(STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=mock)

  # A-42: no cloud cards before opt-in; DIALOG=no writes no settings.json; yes opts in
  mock_start A-42; mkdir -p "$WORK/d42"
  run A-42n "$WORK/d42" "${V2[@]}" STAGECRAFT_SELFTEST_ACTION=opt-in STAGECRAFT_SELFTEST_DIALOG=no
  check A-42n 'r["optIn"]["on"] is False and not os.path.exists(W+"/d42/settings.json") and "Turn on OpenRouter" not in r["sheet"] and "Use free cloud models" in r["sheet"]'
  run A-42y "$WORK/d42" "${V2[@]}" STAGECRAFT_SELFTEST_ACTION=opt-in STAGECRAFT_SELFTEST_DIALOG=yes
  # R-85: after Yes the three provider cards are shown, each off
  check A-42y 'r["optIn"]["on"] is True and json.load(open(W+"/d42/settings.json"))["cloudOptIn"] is True and oct(os.stat(W+"/d42/settings.json").st_mode & 0o777) == "0o600" and "Turn on OpenRouter" in r["sheet"] and sorted(r["cloud"]["state"]["providers"]) == ["gemini", "groq", "openrouter"] and not any(v["enabled"] for v in r["cloud"]["state"]["providers"].values())'

  # A-41: ACL before opt-in, mock after, cloud-off after disable (same process), ACL after relaunch
  mock_start A-41; mkdir -p "$WORK/d41"
  run A-41 "$WORK/d41" "${V2[@]}" STAGECRAFT_SELFTEST_ACTION=a41 STAGECRAFT_SELFTEST_DIALOG=yes
  check A-41 '[a:=r["action"]] and "not allowed" in a["beforeInvoke"] and "not allowed" in a["beforePlugin"] and a["optedIn"] and a["afterOptIn"] == "status 200" and a["afterDisable"] == "cloud-off" and not any("/groq/" in l["path"] for l in mock("A-41"))' A-41
  # A-41n (v2 review): without the mock, DIALOG=yes answers nothing: no opt-in, nothing written
  mkdir -p "$WORK/d41n"
  run A-41n "$WORK/d41n" STAGECRAFT_SELFTEST_ACTION=a41 STAGECRAFT_SELFTEST_DIALOG=yes
  check A-41n 'x == 0 and r["action"]["optedIn"] is False and not os.path.exists(W+"/d41n/settings.json") and "declined" in err("A-41n")'
  run A-41r "$WORK/d41" "${V2[@]}" STAGECRAFT_SELFTEST_ACTION=relaunch-check
  check A-41r '"not allowed" in r["action"]["invoke"] and r["cloud"]["state"]["on"] is False'

  # A-43: a key planted in state.json, a planted opt-in, no key in the store
  mock_start A-43; optin "$WORK/d43" groq; PL="test-only-planted-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  printf '{"keys":{"local":"local","groq":"%s"},"models":{"groq":[{"id":"llama-3.3-70b-versatile","tier":"high"}]},"cloudAck":{"deepen|groq":1,"critique|groq":1,"reconcile|groq":1},"stage":0,"idea":"","outputs":{}}' "$PL" >"$WORK/d43/state.json"
  printf '%s' "$PL" >"$WORK/A-43.planted"            # read by the check, so a FAIL line never shows it
  run A-43 "$WORK/d43" "${V2[@]}"
  check A-43 '[pl:=open(W+"/A-43.planted").read()] and grepc(pl, W+"/d43/state.json", W+"/d43/state.json.bak") == 0 and "was found in Stagecraft" in r["notices"] and "Cloud is on" in r["notices"] and not any(hashlib.sha256(pl.encode()).hexdigest() in json.dumps(l) for l in mock("A-43")) and r["cloud"]["state"]["providers"]["groq"]["present"] is False and not any(c.startswith("groq/") for c in r["candidates"]["high"])'

  # A-44 (live): secret_set probes before storing; nothing is stored on any refusal
  i=0; for pm in "groq 401 rejected" "openrouter 403 rejected" "gemini 400-invalid-key rejected" "groq 500 error" "groq 429 rate-limited"; do
    set -- $pm; i=$((i+1)); mock_start "A-44-$i"; mode "$1" "$2"; optin "$WORK/d44-$i" "$1"
    case $1 in groq) K=$KG;; openrouter) K=$KO;; gemini) K=$KM;; esac
    run "A-44-$i" "$WORK/d44-$i" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="$1:$K"
    check "A-44-$i" "'test key for $1: $3' in err('A-44-$i') and r['cloud']['state']['providers']['$1']['present'] is False"
  done
  mock_stop; optin "$WORK/d44-u" groq
  run A-44-u "$WORK/d44-u" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG"
  check A-44-u '"test key for groq: unreachable" in err("A-44-u") and r["cloud"]["state"]["providers"]["groq"]["present"] is False'

  # A-40 + A-58 + A-54 (live): a Critique through the mock; the key never crosses IPC; the panel comes first
  mock_start A-40; optin "$WORK/d40" groq
  run A-40 "$WORK/d40" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_IPCLOG="$WORK/ipc.log" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9
  check A-40a 'r["stage"]["ok"] and r["stage"]["where"] == "cloud" and r["stage"]["host"] == "api.groq.com" and r["stage"]["provider"] == "groq"' A-40
  check A-58a '[d:=r["cloud"]["disclosures"]] and [c:=chats("A-40")] and len(d) == 1 and d[0]["answer"] == "send" and len(c) == 1 and c[0]["promptSha256"] == d[0]["promptSha256"] and d[0]["at"] <= c[0]["t"]' A-40
  check A-54 '[c:=chats("A-40")[0]] and sorted(c["headers"]) == ["accept","authorization","content-length","content-type","host","user-agent"] and c["headers"]["authorization"].startswith("Bearer sha256:") and c["keyKind"] == "test-key:groq" and grepc("test-only-", W+"/A-40.mock.log") == 0 and all(not any(k in l["headers"] for k in ("origin","referer","cookie","x-probe")) for l in mock("A-40")) and r["xprobe"] == "status 200"' A-40
  mode groq echo-key chat
  run A-40e "$WORK/d40" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_IPCLOG="$WORK/ipc.log" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send
  check A-40e 'any("[key]" in (d.get("detail") or "") for d in r["cloud"]["debug"]) and not any("test-only-" in json.dumps(d) for d in r["cloud"]["debug"])'
  check A-58b 'len(r["cloud"]["disclosures"]) >= 1' A-40e
  mode groq ok
  run A-40x "$WORK/d40" "${V2[@]}" STAGECRAFT_SELFTEST_IPCLOG="$WORK/ipc.log" STAGECRAFT_SELFTEST_ACTION=export STAGECRAFT_SELFTEST_DIALOG="$WORK/x40.md"
  check A-40 "r['action']['result'] == 'saved' and grepc('test-only-', W+'/d40/state.json', W+'/d40/settings.json', W+'/x40.md', W+'/ipc.log') == 0 and os.path.getsize(W+'/ipc.log') > 1000" A-40x
  run A-59c "$WORK/d40" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send STAGECRAFT_SELFTEST_ACTION=export STAGECRAFT_SELFTEST_DIALOG="$WORK/x59.md"
  check A-59x '[md:=open(W+"/x59.md").read()] and r["stage"]["ok"] and "\nSent to: Groq (Critique)\n" in md and "## Critique\n\n_Answered by Groq · llama-3.3-70b-versatile (HIGH) · sent over the internet to api.groq.com_" in md and r["cloud"]["runs"]["critique"]["where"] == "cloud" and r["cloud"]["runs"]["critique"]["host"] == "api.groq.com"' A-59c

  # A-58: tick, then no panel; a per-provider 429 falls back and asks again; a dismissed panel spends nothing
  mock_start A-58; optin "$WORK/d58" groq openrouter
  run A-58t "$WORK/d58" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG,openrouter:$KO" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=tick
  run A-58n "$WORK/d58" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG,openrouter:$KO" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=dismiss
  check A-58t 'len(json.load(open(W+"/A-58t.json"))["cloud"]["disclosures"]) == 1 and r["cloud"]["disclosures"] == [] and r["stage"]["ok"]' A-58n
  mock_start A-58f; mode groq 429 chat; optin "$WORK/d58f" groq openrouter
  run A-58f "$WORK/d58f" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG,openrouter:$KO" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send
  check A-58f '[d["provider"] for d in r["cloud"]["disclosures"]] == ["groq","openrouter"] and r["stage"]["provider"] == "openrouter" and [c["provider"] for c in chats("A-58f")] == ["groq","openrouter"]'
  mock_start A-58d; optin "$WORK/d58d" groq
  run A-58d "$WORK/d58d" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=dismiss
  check A-58d 'not r["stage"]["ok"] and chats("A-58d") == [] and r["cloud"]["ledger"] == {} and "Nothing was sent" in r["stage"]["notices"]'

  # A-61: a local-only idea sends nothing; Fork keeps the flag; the export says it never left;
  #       keep-local-off makes the panel show again even for a ticked pair
  mock_start A-61; optin "$WORK/d61" groq
  run A-61 "$WORK/d61" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=tick STAGECRAFT_SELFTEST_ACTION=keep-local,fork,export STAGECRAFT_SELFTEST_DIALOG="$WORK/x61.md"
  check A-61 'chats("A-61") == [] and r["cloud"]["localOnly"] and r["fork"]["localOnly"] is True and "This idea never left this computer." in open(W+"/x61.md").read()'
  run A-61t "$WORK/d61" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=tick STAGECRAFT_SELFTEST_ACTION=keep-local-off
  run A-61k "$WORK/d61" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send
  run A-61o "$WORK/d61" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send STAGECRAFT_SELFTEST_ACTION=keep-local-off
  check A-61o 'not r["cloud"]["localOnly"] and len(json.load(open(W+"/A-61t.json"))["cloud"]["disclosures"]) == 1 and json.load(open(W+"/A-61k.json"))["cloud"]["disclosures"] == [] and len(r["cloud"]["disclosures"]) == 1 and len(chats("A-61")) == 3'

  # A-59: fork, keep-local on idea B, unfork: idea A's own flag comes back
  run A-59f "$WORK/d61" "${V2[@]}" STAGECRAFT_SELFTEST_ACTION=fork,keep-local-after-fork,unfork
  check A-59f 'r["fork"]["localOnly"] is False and r["unfork"]["localOnly"] is False and r["unfork"]["idea"] != r["fork"]["idea"]'

  # A-59 (slow, optional): the mixed run of every stage - three on Ollama, the four high ones through
  #       the mock (PROPOSAL 2026-11-17: seven stages with Review; it was six, three through the mock)
  if [ "${STAGECRAFT_A59ALL:-0}" = 1 ]; then
    mock_start A-59all; optin "$WORK/d59" groq
    run A-59all "$WORK/d59" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=all STAGECRAFT_SELFTEST_DISCLOSE=send STAGECRAFT_SELFTEST_ACTION=export STAGECRAFT_SELFTEST_DIALOG="$WORK/x59all.md"
    check A-59all '[md:=open(W+"/x59all.md").read()] and r["stage"]["ok"] and [x["where"] for x in r["stage"]["stages"]] == ["local"]*3 + ["cloud"]*4 and "\nSent to: Groq (Deepen, Critique, Reconcile, Review)\n" in md and md.count("_Answered on this computer · ") == 3 and md.count("· sent over the internet to api.groq.com_") == 4 and sorted(c["promptSha256"] for c in chats("A-59all")) == sorted(d["promptSha256"] for d in r["cloud"]["disclosures"])'
  fi

  # A-64 (live): Rust refuses OpenRouter chats on a paid or request-priced model; after a
  #       relaunch it fetches the public list itself (no key) before a free chat
  mock_start A-64; optin "$WORK/d64" openrouter
  run A-64 "$WORK/d64" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="openrouter:$KO" STAGECRAFT_SELFTEST_ACTION=a64
  check A-64 '[a:=r["a64"]] and a["paid"] == "not-allowed" and a["request"] == "not-allowed" and a["free"] == "status 200" and [c["model"] for c in chats("A-64")] == ["mock/llama-3.3-70b-instruct:free"]'
  : >"$WORK/A-64.mock.log"
  run A-64r "$WORK/d64" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=mock STAGECRAFT_SELFTEST_KEYS="openrouter:$KO" STAGECRAFT_SELFTEST_ACTION=a64
  check A-64r '[a:=r["a64"]] and a["free"] == "status 200" and any(l["path"] == "/openrouter/api/v1/models" for l in mock("A-64"))'

  # A-64p (v2 review): in "best" mode a low floor goes to OpenRouter, but never to the model
  #       priced only per request (Rust would refuse it), so the stage answers
  mock_start A-64p; optin "$WORK/d64p" openrouter
  printf '{"cloudRoute":"best","stage":0,"idea":"","outputs":{}}' >"$WORK/d64p/state.json"
  run A-64p "$WORK/d64p" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="openrouter:$KO" STAGECRAFT_SELFTEST_STAGE=diverge STAGECRAFT_SELFTEST_DISCLOSE=send
  check A-64p 'not any("hermes-3-8b-request" in c for c in r["candidates"]["low"]) and any(c.startswith("openrouter/") for c in r["candidates"]["low"]) and r["stage"]["ok"] and r["stage"]["provider"] == "openrouter" and chats("A-64p") and all(c["model"] != "mock/hermes-3-8b-request:free" for c in chats("A-64p"))'

  # A-65: cloud-off mid-call aborts the request, ends the stage stopped (no retry, not DEAD),
  #       counts the sent call, and a direct call is refused with no restart
  mock_start A-65; mode groq slow chat; optin "$WORK/d65" groq
  run A-65 "$WORK/d65" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send STAGECRAFT_SELFTEST_ACTION=cloud-off-midcall
  sleep 1
  check A-65 '[a:=r["action"]] and any(l.get("aborted") for l in mock("A-65")) and a["last"]["reason"] == "stopped" and a["last"]["movedTo"] == "(not retried)" and a["dead"] == [] and a["ledgerAfter"]["groq"]["n"] == a["ledgerBefore"].get("groq",{}).get("n",0) + 1 and a["direct"] == "cloud-off" and not a["saved"]'
  mock_start A-65p; mode groq slow chat; optin "$WORK/d65p" groq
  run A-65p "$WORK/d65p" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send STAGECRAFT_SELFTEST_ACTION=provider-off-midcall
  sleep 1
  check A-65p '[a:=r["action"]] and any(l.get("aborted") for l in mock("A-65p")) and a["last"]["reason"] == "stopped" and a["direct"] == "not-enabled"'

  # A-56 (live): no keychain -> session key (gone after relaunch); a key file only on Yes; locked
  mock_start A-56; optin "$WORK/d56" groq
  run A-56s "$WORK/d56" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=fail STAGECRAFT_SELFTEST_KEYS="groq:session:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send
  check A-56s 'r["cloud"]["state"]["keystore"] == "none" and r["cloud"]["state"]["providers"]["groq"]["store"] == "session" and r["stage"]["ok"]'
  run A-56r "$WORK/d56" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=fail STAGECRAFT_SELFTEST_ACTION=relaunch-check
  check A-56r 'r["action"]["has"]["groq"]["present"] is False'
  run A-56n "$WORK/d56" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=fail STAGECRAFT_SELFTEST_KEYS="groq:file:$KG" STAGECRAFT_SELFTEST_DIALOG=no
  check A-56n '"test key for groq: declined" in err("A-56n") and not os.path.exists(W+"/d56/keys.json")'
  run A-56y "$WORK/d56" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=fail STAGECRAFT_SELFTEST_KEYS="groq:file:$KG" STAGECRAFT_SELFTEST_DIALOG=yes
  check A-56y '"test key for groq: ok" in err("A-56y") and oct(os.stat(W+"/d56/keys.json").st_mode & 0o777) == "0o600" and "groq" in json.load(open(W+"/d56/settings.json"))["keyFileConsentAt"] and r["cloud"]["state"]["providers"]["groq"]["store"] == "file"'
  run A-56c "$WORK/d56" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=fail STAGECRAFT_SELFTEST_DIALOG=no STAGECRAFT_SELFTEST_ACTION=relaunch-check
  check A-56c 'r["action"]["has"]["groq"]["present"] is False and r["cloud"]["state"]["providers"]["groq"]["store"] == "file-unconfirmed"'
  optin "$WORK/d56l" groq
  run A-56l "$WORK/d56l" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=locked STAGECRAFT_SELFTEST_KEYS="groq:$KG"
  check A-56l '"test key for groq: locked" in err("A-56l") and r["cloud"]["state"]["keystore"] == "locked" and not os.path.exists(W+"/d56l/keys.json")'

  # A-40 real keychain half: the real Secret Service, service local.stagecraft.desktop.selftest
  if busctl --user status org.freedesktop.secrets >/dev/null 2>&1; then
    mock_start A-40k; optin "$WORK/d40k" groq
    run A-40k1 "$WORK/d40k" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=real-test STAGECRAFT_SELFTEST_KEYS="groq:$KG"
    run A-40k2 "$WORK/d40k" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=real-test STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send STAGECRAFT_SELFTEST_ACTION=delete-keys
    run A-40k3 "$WORK/d40k" STAGECRAFT_SELFTEST_MOCKCLOUD=$MP STAGECRAFT_SELFTEST_KEYSTORE=real-test STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send
    check A-40k '"test key for groq: ok" in err("A-40k1") and json.load(open(W+"/A-40k2.json"))["stage"]["ok"] and json.load(open(W+"/A-40k2.json"))["deleteKeys"]["groq"] == "deleted" and not r["stage"]["ok"] and len(chats("A-40k")) == 1 and grepc("test-only-", W+"/d40k/state.json", W+"/d40k/settings.json") == 0' A-40k3
  else echo "SKIP  A-40k (no Secret Service on this session)"; fi

  # A-57 (live): Ollama not answering, installed roster kept: no covered stage goes to the cloud
  mock_start A-57; optin "$WORK/d57" groq
  run A-57a "$WORK/d57" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG"
  run A-57 "$WORK/d57" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_OLLAMA=http://127.0.0.1:11435 STAGECRAFT_SELFTEST_STAGE=capture STAGECRAFT_SELFTEST_DISCLOSE=send
  check A-57 'r["ollama"]["version"] is None and not r["stage"]["ok"] and chats("A-57") == [] and r["candidates"]["low"] == [] and all(c.startswith("groq/") for c in r["candidates"]["high"])'

  # A-14 (v2): Forget everything also deletes settings.json, keys.json and every key
  mock_start A-14v; optin "$WORK/d14v" groq
  run A-14v "$WORK/d14v" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_ACTION=forget STAGECRAFT_SELFTEST_DIALOG=yes
  check A-14v 'r["action"]["result"] == "forgotten" and not any(os.path.exists(W+"/d14v/"+f) for f in ("settings.json","keys.json","state.json","state.json.bak"))'
  run A-14vn "$WORK/d14v" "${V2[@]}" STAGECRAFT_SELFTEST_ACTION=relaunch-check
  check A-14vn 'r["previousMarker"] is None and r["cloud"]["state"]["on"] is False and all(not h["present"] for h in r["action"]["has"].values())'

  # A-62(b): with the mock, only 127.0.0.1:{11434, mock}
  if command -v strace >/dev/null; then
    mock_start A-62b; optin "$WORK/d62b" groq
    env STAGECRAFT_SELFTEST="$WORK/A-62b.json" STAGECRAFT_DATA_DIR="$WORK/d62b" "${V2[@]}" STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_STAGE=critique STAGECRAFT_SELFTEST_DISCLOSE=send \
      timeout 300 strace -f -e trace=connect -o "$WORK/A-62b.strace" "$BIN" >"$WORK/A-62b.out" 2>"$WORK/A-62b.err"; echo $? >"$WORK/A-62b.exit"
    check A-62b '[inet:=[l for l in open(W+"/A-62b.strace") if "AF_INET" in l]] and r["stage"]["ok"] and inet and all(re.search(r"sin_port=htons\((11434|'$MP')\).*inet_addr\(\"127\.0\.0\.1\"\)", l) for l in inet if "AF_INET6" not in l) and not any("AF_INET6" in l and "sin6_port" in l for l in inet)'
  fi
  mock_stop
fi

if [ "$DEBUG" = 0 ]; then
  # ---------------- v2, release build (DESIGN §13.10) ----------------
  ELF="$BIN"; case "$BIN" in *.AppImage) ELF="$REPO/desktop/src-tauri/target/release/stagecraft" ;; esac
  # A-63: no debug-only variable name is even in the binary
  strings "$ELF" | grep -cE 'STAGECRAFT_SELFTEST_(MOCKCLOUD|KEYSTORE|KEYS|DISCLOSE|IPCLOG)' >"$WORK/A-63s.n"; echo 0 >"$WORK/A-63s.exit"
  check A-63s 'int(open(W+"/A-63s.n").read()) == 0'
  # A-63 (v2 review): a release build keeps only v1's self-test values (D-29). Given v2 actions,
  # STAGE=all, DIALOG=yes and test keys, it opts nothing in, runs no stage, deletes no key and
  # writes no settings.json; it just reports and exits
  mkdir -p -m 700 "$WORK/d63"
  env STAGECRAFT_SELFTEST="$WORK/A-63d.json" STAGECRAFT_DATA_DIR="$WORK/d63" STAGECRAFT_SELFTEST_ACTION=opt-in,delete-keys STAGECRAFT_SELFTEST_STAGE=all STAGECRAFT_SELFTEST_DIALOG=yes \
      STAGECRAFT_SELFTEST_KEYS="groq:$KG" STAGECRAFT_SELFTEST_MOCKCLOUD=11620 timeout 120 "$BIN" >"$WORK/A-63d.out" 2>"$WORK/A-63d.err"; echo $? >"$WORK/A-63d.exit"
  check A-63d 'x == 0 and not os.path.exists(W+"/d63/settings.json") and not any(k in r for k in ("optIn", "deleteKeys", "stage", "fork")) and r["cloud"]["state"]["on"] is False'
  # the plant-key helper refuses to run outside a private session bus
  if [ -x "$REPO/desktop/src-tauri/target/debug/examples/plant-key" ]; then
    "$REPO/desktop/src-tauri/target/debug/examples/plant-key" groq "$KG" >"$WORK/A-62g.out" 2>&1; echo $? >"$WORK/A-62g.exit"
    check A-62g 'x == 2 and "refusing" in open(W+"/A-62g.out").read()'
  fi
  # A-62(a): cloud off with a key stored (planted in a THROWAWAY keyring on a throwaway session
  # bus, never the user's): every AF_INET connect goes to 127.0.0.1:11434
  PLANT="$REPO/desktop/src-tauri/target/debug/examples/plant-key"
  if command -v strace >/dev/null && command -v dbus-run-session >/dev/null && command -v gnome-keyring-daemon >/dev/null && [ -x "$PLANT" ]; then
    H="$WORK/home62"; mkdir -p -m 700 "$H" "$WORK/d62a"
    printf '{"v":2,"cloudOptIn":false,"providers":{"groq":{"enabled":false,"stored":"keychain"}}}' >"$WORK/d62a/settings.json"
    env HOME="$H" dbus-run-session -- sh -c '
      # --unlock with an empty password makes no collection; PAM-style --login with a throwaway
      # password creates the login keyring, then --start serves it on this private bus
      printf "throwaway" | gnome-keyring-daemon --login --control-directory="$HOME/kr" >/dev/null 2>&1
      gnome-keyring-daemon --start --components=secrets --control-directory="$HOME/kr" >/dev/null 2>&1
      STAGECRAFT_PLANT_KEY_THROWAWAY="$HOME" "$0" groq "$1" >"$2/A-62a.plant" 2>&1
      STAGECRAFT_SELFTEST="$2/A-62a.json" STAGECRAFT_DATA_DIR="$2/d62a" STAGECRAFT_SELFTEST_CHAT=1 \
        timeout 600 strace -f -e trace=connect -o "$2/A-62a.strace" "$3" >"$2/A-62a.out" 2>"$2/A-62a.err"; echo $? >"$2/A-62a.exit"
    ' "$PLANT" "$KG" "$WORK" "$ELF"
    pkill -f "control-directory=$H/kr" 2>/dev/null
    check A-62a '"planted" in open(W+"/A-62a.plant").read() and x == 0 and r["chat"]["ok"] and r["cloud"]["state"]["on"] is False and [inet:=[l for l in open(W+"/A-62a.strace") if "AF_INET" in l]] and inet and all("htons(11434)" in l and "\"127.0.0.1\"" in l for l in inet if "AF_INET6" not in l) and not any("sin6_port" in l for l in inet)'
  else echo "SKIP  A-62a (needs strace, dbus-run-session, gnome-keyring-daemon and cargo build --example plant-key)"; fi
  # A-28 (slow, optional): a full Capture on the release binary, cloud off: only 127.0.0.1:11434
  if [ "${STAGECRAFT_A28:-0}" = 1 ] && command -v strace >/dev/null; then
    mkdir -p "$WORK/d28"
    env STAGECRAFT_SELFTEST="$WORK/A-28.json" STAGECRAFT_DATA_DIR="$WORK/d28" STAGECRAFT_SELFTEST_STAGE=capture \
      timeout 1900 strace -f -e trace=connect -o "$WORK/A-28.strace" "$ELF" >"$WORK/A-28.out" 2>"$WORK/A-28.err"; echo $? >"$WORK/A-28.exit"
    check A-28 'x == 0 and r["stage"]["ok"] and r["cloud"]["state"]["on"] is False and [inet:=[l for l in open(W+"/A-28.strace") if "AF_INET" in l]] and inet and all("htons(11434)" in l and "\"127.0.0.1\"" in l for l in inet if "AF_INET6" not in l) and not any("sin6_port" in l for l in inet)'
  fi
fi

echo "reports in $WORK"
[ "$FAILS" = 0 ] && echo "ALL PASS" || echo "$FAILS FAILED"
exit $([ "$FAILS" = 0 ] && echo 0 || echo 1)
