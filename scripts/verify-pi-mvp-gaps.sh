#!/usr/bin/env bash
#
# Um wizard para validar manualmente os gaps restantes do MVP T3 + Pi.
# Gerado a partir da skill /wizard.
#
# Tudo acima do marcador "STAGES" é a biblioteca do wizard. Não edite essa
# parte ao alterar as etapas.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library — delightful, consistent UX. Identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear — wipe the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" — opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later — it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" — clear the screen, then announce a stage and show progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." — a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." — a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL — open in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser — visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser — visit it manually: $url"
}

# pause "msg" — wait for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" — y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY — current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" — read a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" — like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE — upsert KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE — set a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name — gh not ready; set it later"
}

# set_var NAME VALUE — set a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name — gh not ready; set it later"
}

# finish — clear, then a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES — author this section. One stage() per step the human takes.
# Replace the example below. Set TOTAL_STAGES to match the stages you write.
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=8
CHECKS=()
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_HELPER="$REPO_ROOT/.agents/skills/verify-t3-mobile-pi/helpers/verify-mobile-pi.sh"

WEB_BASE_DIR=""
WEB_SHARED_ORIGIN=""
WEB_SERVER_PORT=""
WEB_PORT=""
WEB_RUNNER_PID=""
WEB_PGID=""
WEB_LOG=""
WEB_CLEANUP_OK=1

MOBILE_SERIAL="${MOBILE_SERIAL:-}"
MOBILE_RUN_DIR=""
MOBILE_STATE_FILE=""
MOBILE_EVIDENCE_DIR=""
MOBILE_BASE_DIR=""
MOBILE_SERVER_PORT="${MOBILE_SERVER_PORT:-}"
MOBILE_ORIGIN="${MOBILE_ORIGIN:-}"
MOBILE_BACKEND_PID=""
MOBILE_BACKEND_PGID=""
MOBILE_METRO_PID=""
MOBILE_METRO_PGID=""
MOBILE_METRO_PORT=""
MOBILE_METRO_OWNED=0
MOBILE_EMULATOR_PID=""
MOBILE_EMULATOR_PGID=""
MOBILE_EMULATOR_OWNED=0
MOBILE_ADB_BIN=""
MOBILE_ADB_REVERSE=0
MOBILE_STATE_WATCHER_PID=""
MOBILE_STATE_WATCH_STOP=""
MOBILE_RECOVERY_STATE_FILE=""
MOBILE_CLEANED=0

MEMORY_MONITOR_PID=""
MEMORY_LOG=""
MEMORY_NOTES=""
REPORT_FILE="${REPORT_FILE:-${TMPDIR:-/tmp}/t3-pi-mvp-validation-$(date -u +%Y%m%dT%H%M%SZ)-$$.md}"

umask 077

record_check() {
  local label="$1" question="$2"
  if confirm "$question"; then
    CHECKS+=("PASS|$label")
    note "PASS: $label"
  else
    CHECKS+=("PENDENTE|$label")
    SKIPPED+=("$label")
    warn "PENDENTE: $label"
  fi
}

record_automatic_check() {
  local label="$1" status="${2:-PASS}"
  CHECKS+=("$status|$label")
  if [[ "$status" == "PASS" ]]; then
    note "PASS: $label"
  else
    SKIPPED+=("$label")
    warn "PENDENTE: $label"
  fi
}

die() {
  warn "$1"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "comando ausente: $1"
}

run_action() {
  local label="$1"
  shift
  say "Executando: $label"
  "$@"
  note "concluído: $label"
}

prompt_line() { printf '  %s>%s %s\n' "$BLUE" "$RESET" "$1"; }
expected() { printf '  %s✓ esperado:%s %s\n' "$GREEN" "$RESET" "$1"; }

redact_web_output() {
  sed -u -E \
    -e '/[█▀▄▌▐]/d' \
    -e "s#https?://[^[:space:]\"']+/pair[^[:space:]\"']*#<pairing-url-redacted>#g" \
    -e "s#(token=)[^&[:space:]\"']+#\1<redacted>#g" \
    -e "s#(Token:[[:space:]]+)[^[:space:]]+#\1<redacted>#g"
}

configure_pi() {
  local base_dir="$1"
  mkdir -p -- "$base_dir/userdata"
  PI_SETTINGS_PATH="$base_dir/userdata/settings.json" node -e '
    const fs = require("node:fs");
    const path = process.env.PI_SETTINGS_PATH;
    fs.writeFileSync(path, JSON.stringify({
      providerInstances: { pi: { driver: "pi", enabled: true, config: {} } },
    }, null, 2) + "\n");
  '
}

add_project() {
  local base_dir="$1"
  if ! node "$REPO_ROOT/apps/server/src/bin.ts" project add "$REPO_ROOT" \
    --base-dir "$base_dir" \
    --title "T3 Code Pi verification" > "$base_dir/project-add.log" 2>&1; then
    warn "não foi possível adicionar o projeto; veja $base_dir/project-add.log"
    return 1
  fi
}

process_group_alive() {
  local pid="${1:-}" pgid="${2:-}"
  [[ "$pgid" =~ ^[0-9]+$ ]] || pgid="$pid"
  kill -0 -- "-$pgid" 2>/dev/null || {
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
  }
}

stop_process_group() {
  local pid="${1:-}" pgid="${2:-${1:-}}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  process_group_alive "$pid" "$pgid" || return 0

  kill -INT -- "-$pgid" 2>/dev/null || kill -INT "$pid" 2>/dev/null || true
  for ((i = 0; i < 40; i += 1)); do
    process_group_alive "$pid" "$pgid" || return 0
    sleep 0.25
  done
  kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for ((i = 0; i < 40; i += 1)); do
    process_group_alive "$pid" "$pgid" || return 0
    sleep 0.25
  done
  kill -KILL -- "-$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  for ((i = 0; i < 10; i += 1)); do
    process_group_alive "$pid" "$pgid" || return 0
    sleep 0.25
  done
  return 1
}

start_web_runner() {
  require_command pnpm
  require_command curl
  require_command setsid
  WEB_LOG="$WEB_BASE_DIR/.dev-runner.log"
  : > "$WEB_LOG"
  (
    cd -- "$REPO_ROOT"
    exec setsid pnpm exec vp run dev --share --home-dir "$WEB_BASE_DIR"
  ) > >(redact_web_output >> "$WEB_LOG") 2>&1 &
  WEB_RUNNER_PID=$!
  # `setsid` makes the captured PID the process-group leader. Do not query
  # `ps` here: a race could observe the wizard's own group before `setsid` execs.
  WEB_PGID="$WEB_RUNNER_PID"
}

stop_web_runner() {
  [[ -n "$WEB_RUNNER_PID" ]] || return 0
  if stop_process_group "$WEB_RUNNER_PID" "$WEB_PGID"; then
    wait "$WEB_RUNNER_PID" 2>/dev/null || true
    WEB_RUNNER_PID=""
    WEB_PGID=""
    return 0
  fi
  WEB_CLEANUP_OK=0
  warn "o dev runner não encerrou pelo PID capturado: $WEB_RUNNER_PID"
  return 1
}

wait_for_web_runner() {
  local deadline=$((SECONDS + 150))
  while (( SECONDS < deadline )); do
    kill -0 "$WEB_RUNNER_PID" 2>/dev/null || {
      warn "o dev runner encerrou antes de ficar pronto; log sanitizado: $WEB_LOG"
      tail -n 30 "$WEB_LOG" 2>/dev/null || true
      return 1
    }
    if grep -Fq "could not share on the tailnet" "$WEB_LOG"; then
      warn "o Tailscale Serve falhou antes de o web ficar disponível; não prossigo com uma URL que pode responder 502"
      tail -n 30 "$WEB_LOG" 2>/dev/null || true
      return 1
    fi
    WEB_SHARED_ORIGIN="$(awk '/shared on tailnet:/ {sub(/^.*shared on tailnet: /, ""); print; exit}' "$WEB_LOG")"
    WEB_SHARED_ORIGIN="${WEB_SHARED_ORIGIN%/}"
    WEB_SERVER_PORT="$(sed -n 's/.*serverPort=\([0-9][0-9]*\).*/\1/p' "$WEB_LOG" | head -n 1)"
    WEB_PORT="$(sed -n 's/.*webPort=\([0-9][0-9]*\).*/\1/p' "$WEB_LOG" | head -n 1)"
    if [[ -n "$WEB_SHARED_ORIGIN" && -n "$WEB_SERVER_PORT" && -n "$WEB_PORT" ]] && \
      curl -fsS --max-time 2 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && \
      curl -fsS --max-time 2 "$WEB_SHARED_ORIGIN/.well-known/t3/environment" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  warn "o web não ficou pronto; log sanitizado: $WEB_LOG"
  tail -n 30 "$WEB_LOG" 2>/dev/null || true
  return 1
}

start_web_environment() {
  require_command node
  require_command pnpm
  require_command curl
  require_command tailscale
  tailscale status >/dev/null || die "Tailscale não está conectado; execute tailscale up e tente novamente"
  WEB_BASE_DIR="$(mktemp -d /tmp/t3-pi-mvp-web.XXXXXX)"
  run_action "configuração Pi em $WEB_BASE_DIR" configure_pi "$WEB_BASE_DIR"
  run_action "registro do projeto no ambiente web" add_project "$WEB_BASE_DIR"
  say "Iniciando o web compartilhado por Tailscale Serve..."
  start_web_runner
  wait_for_web_runner
  note "origem web compartilhada: $WEB_SHARED_ORIGIN"
  note "backend local: http://127.0.0.1:$WEB_SERVER_PORT; web local: http://127.0.0.1:$WEB_PORT"
}

mint_web_pairing() {
  say "Emitindo um pairing URL fresco; ele será mostrado somente no terminal."
  T3CODE_PORT="$WEB_SERVER_PORT" node "$REPO_ROOT/apps/server/src/bin.ts" auth pairing create \
    --base-dir "$WEB_BASE_DIR" \
    --base-url "$WEB_SHARED_ORIGIN" \
    --ttl 15m \
    --label pi-mvp-web
  : > "$WEB_LOG"
}

select_android_device() {
  require_command adb
  while :; do
    local devices=()
    mapfile -t devices < <(adb devices | awk 'NR > 1 && $2 == "device" {print $1}')
    if [[ -n "$MOBILE_SERIAL" ]]; then
      if [[ "$(adb -s "$MOBILE_SERIAL" get-state 2>/dev/null || true)" == "device" ]]; then
        note "aparelho Android selecionado: $MOBILE_SERIAL"
        return 0
      fi
      warn "MOBILE_SERIAL não está autorizado: $MOBILE_SERIAL"
      MOBILE_SERIAL=""
    elif (( ${#devices[@]} == 1 )); then
      MOBILE_SERIAL="${devices[0]}"
      note "aparelho Android detectado automaticamente: $MOBILE_SERIAL"
      return 0
    elif (( ${#devices[@]} > 1 )); then
      ask MOBILE_SERIAL "Há vários aparelhos; escolha o serial exibido por adb devices:"
    else
      warn "nenhum aparelho Android autorizado foi detectado; conecte/desbloqueie um e aceite a autorização USB."
      adb devices
      pause "Pressione Enter para verificar adb devices novamente."
    fi
  done
}

choose_mobile_port() {
  [[ -n "$MOBILE_SERVER_PORT" ]] && return 0
  if [[ "$MOBILE_ORIGIN" =~ :([0-9]+)$ ]]; then
    MOBILE_SERVER_PORT="${BASH_REMATCH[1]}"
    note "porta Android extraída do origin fornecido: $MOBILE_SERVER_PORT"
    return 0
  fi
  MOBILE_SERVER_PORT=14273
  if command -v ss >/dev/null 2>&1; then
    for ((i = 0; i < 50; i += 1)); do
      [[ -z "$(ss -H -ltn "sport = :$MOBILE_SERVER_PORT" 2>/dev/null)" ]] && break
      MOBILE_SERVER_PORT=$((MOBILE_SERVER_PORT + 1))
    done
  fi
  note "porta Android escolhida: $MOBILE_SERVER_PORT"
}

validate_mobile_origin() {
  local host port
  if [[ ! "$MOBILE_ORIGIN" =~ ^https?://([^/:]+):([0-9]+)$ ]]; then
    die "MOBILE_ORIGIN precisa ter o formato http(s)://host:porta, sem caminho: $MOBILE_ORIGIN"
  fi
  host="${BASH_REMATCH[1]}"
  port="${BASH_REMATCH[2]}"
  case "$host" in
    localhost | 0.0.0.0 | 127.* | 10.0.2.2)
      die "MOBILE_ORIGIN precisa apontar para um IP LAN/Tailscale alcançável pelo aparelho: $MOBILE_ORIGIN"
      ;;
  esac
  [[ "$port" == "$MOBILE_SERVER_PORT" ]] || \
    die "a porta de MOBILE_ORIGIN ($port) difere de MOBILE_SERVER_PORT ($MOBILE_SERVER_PORT)"
}

choose_mobile_origin() {
  [[ -n "$MOBILE_ORIGIN" ]] && {
    note "origin Android fornecido: $MOBILE_ORIGIN"
    validate_mobile_origin
    return 0
  }
  local tailscale_ip="" lan_ip="" choice="1"
  if command -v tailscale >/dev/null 2>&1; then
    tailscale_ip="$(tailscale ip -4 2>/dev/null || true)"
  fi
  if command -v ip >/dev/null 2>&1; then
    lan_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i += 1) if ($i == "src") {print $(i + 1); exit}}')"
  fi
  if [[ -n "$tailscale_ip" && -n "$lan_ip" ]]; then
    printf '  %sRede Android:%s [1] Tailscale (recomendado) [2] LAN [Enter = 1] ' "$BOLD" "$RESET"
    read -r choice || true
    case "$choice" in
      2) tailscale_ip="" ;;
      1 | "") ;;
      *) die "opção de rede Android inválida: $choice" ;;
    esac
  fi
  if [[ -n "$tailscale_ip" ]]; then
    MOBILE_ORIGIN="http://$tailscale_ip:$MOBILE_SERVER_PORT"
    note "origin Android escolhido automaticamente pela Tailscale: $MOBILE_ORIGIN"
  elif [[ -n "$lan_ip" ]]; then
    MOBILE_ORIGIN="http://$lan_ip:$MOBILE_SERVER_PORT"
    note "origin Android escolhido automaticamente pela LAN: $MOBILE_ORIGIN"
  else
    die "não encontrei IP LAN nem IP Tailscale; defina MOBILE_ORIGIN e execute novamente"
  fi
  validate_mobile_origin
}

issue_mobile_pairing() {
  local ttl="$1" label="$2"
  # shellcheck disable=SC1090
  source "$MOBILE_STATE_FILE"
  say "Emitindo pairing token para $MOBILE_ORIGIN (TTL $ttl); o token não será salvo pelo wizard."
  T3CODE_PORT="$SERVER_PORT" node "$REPO_ROOT/apps/server/src/bin.ts" auth pairing create \
    --base-dir "$BASE_DIR" \
    --base-url "$MOBILE_ORIGIN" \
    --ttl "$ttl" \
    --label "$label"
}

wait_for_android_surface() {
  # shellcheck disable=SC1090
  source "$MOBILE_STATE_FILE"
  local remote_xml='/sdcard/t3-pi-mvp-surface.xml' ui=""
  for ((i = 0; i < 60; i += 1)); do
    "$ADB_BIN" -s "$ADB_SERIAL" shell uiautomator dump "$remote_xml" >/dev/null 2>&1 || true
    ui="$("$ADB_BIN" -s "$ADB_SERIAL" exec-out cat "$remote_xml" 2>/dev/null || true)"
    "$ADB_BIN" -s "$ADB_SERIAL" shell rm -f -- "$remote_xml" >/dev/null 2>&1 || true
    if [[ "$ui" == *Continue* || "$ui" == *"New task"* || "$ui" == *"Add Environment"* ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

open_android_client() {
  # shellcheck disable=SC1090
  source "$MOBILE_STATE_FILE"
  export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"
  "$ADB_BIN" -s "$ADB_SERIAL" shell am start -W \
    -a android.intent.action.VIEW \
    -d "t3code-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A$METRO_PORT" \
    com.t3tools.t3code.dev >/dev/null
  wait_for_android_surface || warn "o dev client ainda não expôs uma tela conhecida; abrindo Add Environment mesmo assim"
  "$ADB_BIN" -s "$ADB_SERIAL" shell am start -W \
    -a android.intent.action.VIEW \
    -d 't3code-dev://connections/new' \
    com.t3tools.t3code.dev >/dev/null
}

capture_mobile_runtime_state() {
  local state_source="${1:-$MOBILE_STATE_FILE}"
  [[ -f "$state_source" ]] || return 1
  # shellcheck disable=SC1090
  source "$state_source"
  MOBILE_BACKEND_PID="${BACKEND_PID:-}"
  MOBILE_BACKEND_PGID="$MOBILE_BACKEND_PID"
  MOBILE_METRO_PID="${METRO_PID:-}"
  MOBILE_METRO_PGID="$MOBILE_METRO_PID"
  MOBILE_METRO_PORT="${METRO_PORT:-}"
  MOBILE_METRO_OWNED="${METRO_OWNED:-0}"
  MOBILE_EMULATOR_PID="${EMULATOR_PID:-}"
  MOBILE_EMULATOR_PGID="$MOBILE_EMULATOR_PID"
  MOBILE_EMULATOR_OWNED="${EMULATOR_OWNED:-0}"
  MOBILE_ADB_BIN="${ADB_BIN:-}"
  MOBILE_ADB_REVERSE="${ADB_REVERSE:-0}"
  MOBILE_SERVER_PORT="${SERVER_PORT:-$MOBILE_SERVER_PORT}"
  MOBILE_SERIAL="${ADB_SERIAL:-$MOBILE_SERIAL}"
  MOBILE_EVIDENCE_DIR="${EVIDENCE_DIR:-$MOBILE_EVIDENCE_DIR}"
  MOBILE_BASE_DIR="${BASE_DIR:-$MOBILE_BASE_DIR}"
}

start_mobile_state_watcher() {
  MOBILE_STATE_WATCH_STOP="$MOBILE_RUN_DIR/stop-state-watch"
  MOBILE_RECOVERY_STATE_FILE="$MOBILE_RUN_DIR/recovery-state.env"
  rm -f -- "$MOBILE_STATE_WATCH_STOP" "$MOBILE_RECOVERY_STATE_FILE"
  (
    while [[ ! -e "$MOBILE_STATE_WATCH_STOP" ]]; do
      if [[ -f "$MOBILE_STATE_FILE" ]] && grep -Eq '^BACKEND_PID=[1-9][0-9]*$' "$MOBILE_STATE_FILE"; then
        temporary="$MOBILE_RECOVERY_STATE_FILE.tmp.$$"
        if cp -- "$MOBILE_STATE_FILE" "$temporary"; then
          mv -- "$temporary" "$MOBILE_RECOVERY_STATE_FILE"
        fi
        exit 0
      fi
      sleep 0.25
    done
  ) &
  MOBILE_STATE_WATCHER_PID=$!
}

stop_mobile_state_watcher() {
  [[ -n "$MOBILE_STATE_WATCHER_PID" ]] || return 0
  : > "$MOBILE_STATE_WATCH_STOP"
  kill -TERM "$MOBILE_STATE_WATCHER_PID" 2>/dev/null || true
  wait "$MOBILE_STATE_WATCHER_PID" 2>/dev/null || true
  MOBILE_STATE_WATCHER_PID=""
}

start_mobile_environment() {
  select_android_device
  choose_mobile_port
  choose_mobile_origin
  note "Antes do bootstrap, confirme que o aparelho está na mesma LAN/tailnet que alcança $MOBILE_ORIGIN."
  pause "Pressione Enter quando essa condição física de rede estiver confirmada."
  MOBILE_RUN_DIR="$(mktemp -d /tmp/t3-pi-mvp-mobile.XXXXXX)"
  # O helper preserva bases externas ao RUN_DIR. Assim o wizard só apaga a
  # base depois de comprovar que processos, portas e reverse ADB terminaram.
  MOBILE_BASE_DIR="$(mktemp -d /tmp/t3-pi-mvp-mobile-base.XXXXXX)"
  MOBILE_STATE_FILE="$MOBILE_RUN_DIR/state.env"
  MOBILE_EVIDENCE_DIR="$MOBILE_RUN_DIR/evidence"
  start_mobile_state_watcher
  say "Executando launch Android isolado em $MOBILE_RUN_DIR"
  if ! env \
    REPO_ROOT="$REPO_ROOT" \
    RUN_DIR="$MOBILE_RUN_DIR" \
    BASE_DIR="$MOBILE_BASE_DIR" \
    ADB_SERIAL="$MOBILE_SERIAL" \
    REUSE_ANDROID_DEVICE=1 \
    SERVER_BIND_HOST=0.0.0.0 \
    SERVER_PORT="$MOBILE_SERVER_PORT" \
    MOBILE_ORIGIN="$MOBILE_ORIGIN" \
    "$MOBILE_HELPER" launch; then
    stop_mobile_state_watcher
    capture_mobile_runtime_state "$MOBILE_RECOVERY_STATE_FILE" || true
    return 1
  fi
  stop_mobile_state_watcher
  capture_mobile_runtime_state "$MOBILE_STATE_FILE" || die "launch terminou sem state.env utilizável"
  note "concluído: launch Android isolado em $MOBILE_RUN_DIR"
  run_action "doctor do Android, backend, Metro e Pi" env RUN_DIR="$MOBILE_RUN_DIR" "$MOBILE_HELPER" doctor
  run_action "preparação automática da imagem no aparelho" env RUN_DIR="$MOBILE_RUN_DIR" \
    "$MOBILE_HELPER" prepare-image "$REPO_ROOT/apps/mobile/assets/android-icon-mark.png"
  sanitize_mobile_logs
  issue_mobile_pairing 15m pi-mvp-android
  open_android_client
}

sanitize_mobile_logs() {
  local file temporary
  for file in "$MOBILE_EVIDENCE_DIR"/logs/*.log; do
    [[ -f "$file" ]] || continue
    temporary="$file.sanitized.$$"
    if redact_web_output < "$file" > "$temporary"; then
      mv -- "$temporary" "$file"
    else
      rm -f -- "$temporary"
    fi
  done
}

start_memory_monitor() {
  # shellcheck disable=SC1090
  source "$MOBILE_STATE_FILE"
  MEMORY_LOG="$MOBILE_EVIDENCE_DIR/memory-monitor.log"
  : > "$MEMORY_LOG"
  local backend_pid="$BACKEND_PID"
  (
    while kill -0 "$backend_pid" 2>/dev/null; do
      printf 'timestamp=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      ps -eo pid=,ppid=,pgid=,rss=,vsz=,etime=,args= | awk -v pgid="$backend_pid" '$3 == pgid'
      sleep 2
    done
  ) > "$MEMORY_LOG" 2>&1 &
  MEMORY_MONITOR_PID=$!
}

stop_memory_monitor() {
  [[ -n "$MEMORY_MONITOR_PID" ]] || return 0
  kill -TERM "$MEMORY_MONITOR_PID" 2>/dev/null || true
  wait "$MEMORY_MONITOR_PID" 2>/dev/null || true
  MEMORY_MONITOR_PID=""
}

summarize_memory() {
  local max_rss="0"
  if [[ -f "$MEMORY_LOG" ]]; then
    max_rss="$(awk '$1 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ {if ($4 > max) max = $4} END {print max + 0}' "$MEMORY_LOG")"
  fi
  MEMORY_NOTES="monitor=$MEMORY_LOG; max_rss_kb=$max_rss"
  note "medição registrada em $MEMORY_LOG (maior RSS observado: ${max_rss} KB)"
}

collect_mobile_evidence() {
  [[ -f "$MOBILE_STATE_FILE" ]] || return 1
  local result=0
  sanitize_mobile_logs
  if ! env RUN_DIR="$MOBILE_RUN_DIR" "$MOBILE_HELPER" capture final >/dev/null 2>&1; then
    warn "não consegui capturar a tela final do Android; evidência anterior foi preservada"
    result=1
  fi
  if [[ ! -s "$MOBILE_EVIDENCE_DIR/final.png" || ! -s "$MOBILE_EVIDENCE_DIR/final.ui.xml" ]]; then
    warn "a captura final não produziu final.png e final.ui.xml"
    result=1
  fi
  if ! env RUN_DIR="$MOBILE_RUN_DIR" "$MOBILE_HELPER" db-proof >/dev/null 2>&1; then
    warn "não consegui gerar db-proof; evidência anterior foi preservada"
    result=1
  fi
  [[ -s "$MOBILE_EVIDENCE_DIR/db-proof.txt" ]] || result=1
  return "$result"
}

port_is_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    [[ -n "$(ss -H -ltn "sport = :$port" 2>/dev/null)" ]]
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
    return
  fi
  return 2
}

cleanup_mobile() {
  [[ "$MOBILE_CLEANED" == 1 ]] && return 0
  local result=0 resources_clear=1
  if [[ -f "$MOBILE_STATE_FILE" ]] && ! env RUN_DIR="$MOBILE_RUN_DIR" "$MOBILE_HELPER" cleanup >/dev/null 2>&1; then
    warn "o helper Android reportou falha no cleanup; fazendo a verificação capturada"
    result=1
  fi

  if [[ "$MOBILE_BACKEND_PID" =~ ^[0-9]+$ ]]; then
    if ! stop_process_group "$MOBILE_BACKEND_PID" "$MOBILE_BACKEND_PGID"; then
      result=1
      resources_clear=0
    fi
    if process_group_alive "$MOBILE_BACKEND_PID" "$MOBILE_BACKEND_PGID"; then
      result=1
      resources_clear=0
    fi
  fi
  if [[ "$MOBILE_METRO_OWNED" == 1 && "$MOBILE_METRO_PID" =~ ^[0-9]+$ ]]; then
    if ! stop_process_group "$MOBILE_METRO_PID" "$MOBILE_METRO_PGID"; then
      result=1
      resources_clear=0
    fi
    if process_group_alive "$MOBILE_METRO_PID" "$MOBILE_METRO_PGID"; then
      result=1
      resources_clear=0
    fi
  fi
  if [[ "$MOBILE_EMULATOR_OWNED" == 1 && "$MOBILE_EMULATOR_PID" =~ ^[0-9]+$ ]]; then
    if ! stop_process_group "$MOBILE_EMULATOR_PID" "$MOBILE_EMULATOR_PGID"; then
      result=1
      resources_clear=0
    fi
    if process_group_alive "$MOBILE_EMULATOR_PID" "$MOBILE_EMULATOR_PGID"; then
      result=1
      resources_clear=0
    fi
  fi

  local port port_status
  for port in "$MOBILE_SERVER_PORT"; do
    [[ -n "$port" ]] || continue
    if port_is_listening "$port"; then
      port_status=0
    else
      port_status=$?
    fi
    if (( port_status == 0 )); then
      warn "a porta Android capturada ainda está ocupada: $port"
      result=1
      resources_clear=0
    elif (( port_status == 2 )); then
      warn "não consegui verificar a porta Android capturada: $port"
      result=1
      resources_clear=0
    fi
  done
  if [[ "$MOBILE_METRO_OWNED" == 1 && -n "$MOBILE_METRO_PORT" ]]; then
    if port_is_listening "$MOBILE_METRO_PORT"; then
      port_status=0
    else
      port_status=$?
    fi
    if (( port_status == 0 )); then
      warn "a porta Metro capturada ainda está ocupada: $MOBILE_METRO_PORT"
      result=1
      resources_clear=0
    elif (( port_status == 2 )); then
      warn "não consegui verificar a porta Metro capturada: $MOBILE_METRO_PORT"
      result=1
      resources_clear=0
    fi
  fi

  if [[ "$MOBILE_ADB_REVERSE" == 1 ]]; then
    if [[ -z "$MOBILE_ADB_BIN" || -z "$MOBILE_SERIAL" || -z "$MOBILE_METRO_PORT" ]]; then
      warn "não consegui verificar o reverse ADB capturado"
      result=1
      resources_clear=0
    else
      local reverse_list
      if ! reverse_list="$("$MOBILE_ADB_BIN" -s "$MOBILE_SERIAL" reverse --list 2>/dev/null)"; then
        warn "não consegui consultar o reverse ADB no aparelho capturado"
        result=1
        resources_clear=0
      elif grep -Fq "tcp:$MOBILE_METRO_PORT" <<< "$reverse_list"; then
        if ! "$MOBILE_ADB_BIN" -s "$MOBILE_SERIAL" reverse --remove "tcp:$MOBILE_METRO_PORT" >/dev/null 2>&1; then
          result=1
          resources_clear=0
        elif ! reverse_list="$("$MOBILE_ADB_BIN" -s "$MOBILE_SERIAL" reverse --list 2>/dev/null)"; then
          warn "não consegui confirmar a remoção do reverse ADB"
          result=1
          resources_clear=0
        elif grep -Fq "tcp:$MOBILE_METRO_PORT" <<< "$reverse_list"; then
          result=1
          resources_clear=0
        fi
      fi
    fi
  fi
  if (( resources_clear == 1 )) && [[ -n "$MOBILE_BASE_DIR" && -e "$MOBILE_BASE_DIR" ]]; then
    local resolved_base=""
    resolved_base="$(realpath -- "$MOBILE_BASE_DIR" 2>/dev/null || true)"
    if [[ "$resolved_base" == /tmp/t3-pi-mvp-mobile-base.* ]] && \
      [[ "$(dirname -- "$resolved_base")" == /tmp ]] && [[ "$resolved_base" != /tmp ]]; then
      rm -rf -- "$resolved_base" || result=1
    else
      warn "base Android externo preservado: $MOBILE_BASE_DIR"
      result=1
    fi
  elif (( resources_clear == 0 )) && [[ -n "$MOBILE_BASE_DIR" && -e "$MOBILE_BASE_DIR" ]]; then
    warn "base Android preservado enquanto algum recurso capturado continua ativo: $MOBILE_BASE_DIR"
    result=1
  fi
  [[ -e "$MOBILE_STATE_FILE" ]] && result=1
  [[ -n "$MOBILE_BASE_DIR" && -e "$MOBILE_BASE_DIR" ]] && result=1

  if (( result == 0 )); then
    [[ -z "$MOBILE_RECOVERY_STATE_FILE" ]] || rm -f -- "$MOBILE_RECOVERY_STATE_FILE"
    [[ -z "$MOBILE_STATE_WATCH_STOP" ]] || rm -f -- "$MOBILE_STATE_WATCH_STOP"
    MOBILE_CLEANED=1
    return 0
  fi
  warn "o cleanup Android não foi comprovado; evidência preservada em $MOBILE_EVIDENCE_DIR"
  return 1
}

cleanup_web() {
  local result=0
  stop_web_runner || result=1
  local port port_status
  for port in "$WEB_SERVER_PORT" "$WEB_PORT"; do
    [[ -n "$port" ]] || continue
    if port_is_listening "$port"; then
      port_status=0
    else
      port_status=$?
    fi
    if (( port_status == 0 )); then
      warn "a porta web $port ainda está ocupada após o stop"
      result=1
    elif (( port_status == 2 )); then
      warn "não consegui verificar a porta web: $port"
      result=1
    fi
  done
  return "$result"
}

delete_web_base() {
  local resolved=""
  resolved="$(realpath -- "$WEB_BASE_DIR" 2>/dev/null || true)"
  if [[ "$resolved" == /tmp/t3-pi-mvp-web.* ]] && \
    [[ "$(dirname -- "$resolved")" == /tmp ]] && [[ "$resolved" != /tmp ]]; then
    if rm -rf -- "$resolved"; then
      note "base-dir web temporário removido automaticamente: $resolved"
    else
      warn "não consegui remover o base-dir web temporário: $resolved"
      WEB_CLEANUP_OK=0
    fi
  else
    warn "não removi o base-dir web: caminho não corresponde ao diretório temporário esperado"
    WEB_CLEANUP_OK=0
  fi
}

cleanup_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  stop_memory_monitor || true
  stop_mobile_state_watcher || true
  sanitize_mobile_logs || true
  stop_web_runner || true
  cleanup_mobile || true
  exit "$status"
}

finish_validation() {
  _clear
  {
    printf '# T3 + Pi MVP validation\n\n'
    printf -- '- generated: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf -- '- web base-dir: %s\n' "${WEB_BASE_DIR:-not captured}"
    printf -- '- web origin: %s\n' "${WEB_SHARED_ORIGIN:-not captured}"
    printf -- '- mobile origin: %s\n' "${MOBILE_ORIGIN:-not captured}"
    printf -- '- mobile run dir: %s\n' "${MOBILE_RUN_DIR:-not captured}"
    printf -- '- mobile evidence dir: %s\n' "${MOBILE_EVIDENCE_DIR:-not captured}"
    printf -- '- memory notes: %s\n' "${MEMORY_NOTES:-not captured}"
    printf '\n## Checks\n\n'
    for check in "${CHECKS[@]}"; do
      IFS='|' read -r status label <<< "$check"
      printf -- '- %s: %s\n' "$status" "$label"
    done
    printf '\n## Notes\n\nHuman free-form notes are intentionally not persisted.\n'
  } > "$REPORT_FILE"
  printf '\n%s%s  Validação encerrada%s\n' "$BOLD" "$BLUE" "$RESET"
  printf '\n'
  for check in "${CHECKS[@]}"; do
    IFS='|' read -r status label <<< "$check"
    if [[ "$status" == "PASS" ]]; then
      printf '  %s✓%s %s%s%s\n' "$GREEN" "$RESET" "$GREEN" "$label" "$RESET"
    else
      printf '  %s•%s %s%s%s\n' "$YELLOW" "$RESET" "$YELLOW" "$label" "$RESET"
    fi
  done
  printf '\n'
  if (( ${#SKIPPED[@]} )); then
    warn "Há itens pendentes. Não trate o MVP como fechado até reproduzi-los ou registrar a decisão de adiá-los."
  else
    printf '  %sTudo que este wizard cobre passou.%s\n' "$GREEN" "$RESET"
  fi
  note "Relatório sem tokens: $REPORT_FILE"
  printf '\n'
}

banner "Validação dos gaps do MVP T3 + Pi"
say "O script executa todo setup determinístico e pausa somente para navegador, aparelho, rede e observação do resultado."
say "Ele usa diretórios temporários próprios, não toca em ~/.t3/userdata e não salva tokens em arquivos de evidência."
note "Checkout usado: $REPO_ROOT"
note "O helper Android versionado prepara settings, projeto, APK, Metro, backend, PIDs, imagem e cleanup."
note "Pairing URLs e tokens aparecem apenas no terminal para você copiar; nunca os cole no wizard."
trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stage "Preparar automaticamente o web remoto"
say "O wizard vai criar o base-dir, habilitar Pi, registrar o projeto e iniciar o web compartilhado."
start_web_environment
step "No segundo navegador ou computador, abra primeiro a origem sem /pair nem #token: $WEB_SHARED_ORIGIN"
expected "o dispositivo remoto alcança o web e mostra T3 Code pedindo autenticação, sem consumir token."
pause "Pressione Enter depois de confirmar no segundo dispositivo que a origem sem token é alcançável."
mint_web_pairing
step "Copie o Pair URL fresco exibido acima, abra-o uma única vez no segundo dispositivo e não o abra no host."
pause "Pressione Enter depois que o pairing URL estiver aberto no segundo dispositivo."

stage "Validar o web remoto"
say "O projeto já foi registrado e o Pi já foi habilitado pelo script. Agora só falta exercitar a UI remota."
step "Abra New task, selecione o projeto T3 Code Pi verification e escolha Pi → pi/openai-codex/gpt-5.6-sol / GPT-5.6 Sol · Full."
step "Envie exatamente WEB-REMOTE-OK e aguarde o turno terminar na mesma thread."
expected "a resposta chega sem erro, sem thread nova e sem spinner permanente."
step "Anexe um PNG/JPEG pequeno que esteja disponível no segundo dispositivo e envie:"
prompt_line "Responda exatamente WEB-IMAGE-OK e diga em uma frase o que você vê na imagem."
step "Aguarde o estado terminal e confirme que a miniatura continua na mensagem enviada."
expected "texto, anexo e resposta chegam juntos pelo web remoto."
note "O link compartilhado é HTTPS; isso também é compatível com app.t3.codes. Um backend HTTP privado não é compatível com a página hospedada."
record_check "Web remoto com texto e imagem" "O segundo dispositivo pareou, selecionou o Pi e completou texto e imagem?"

stage "Preparar automaticamente o Android"
say "O script vai detectar o aparelho, escolher uma porta livre, escolher Tailscale (ou LAN), executar o helper, validar tudo, copiar a imagem e abrir o dev client."
start_mobile_environment
note "Host para Add Environment: $MOBILE_ORIGIN"
note "A imagem android-icon-mark.png já foi copiada para Pictures no aparelho como t3-wayfinder.png."
step "No app aberto pelo script, toque Continue se aparecer o menu de desenvolvimento e aguarde New task/Add Environment."
step "Use Host $MOBILE_ORIGIN e o pairing token exibido acima; o token não foi armazenado pelo wizard."
pause "Pressione Enter depois que o formulário Add Environment estiver aberto e pronto para parear."

stage "Validar o Android por rede real"
say "Agora a validação é somente no app: o backend, Metro, Pi, APK, reverse ADB, projeto e imagem já foram preparados automaticamente."
step "Complete o pairing usando o Host indicado e selecione Pi → pi/openai-codex/gpt-5.6-sol / GPT-5.6 Sol · Full."
step "Envie exatamente ANDROID-NETWORK-OK e aguarde o estado terminal na mesma thread."
expected "a resposta chega por LAN/Tailscale e não fica em Working for ... indefinidamente."
step "Abra Add attachment, selecione t3-wayfinder.png em Pictures e envie:"
prompt_line "Responda exatamente ANDROID-IMAGE-OK e diga em uma frase o que você vê na imagem."
step "Aguarde o estado terminal e confirme que a miniatura continua na mensagem enviada."
expected "texto, anexo e resposta chegam pelo origin de rede real; localhost, 0.0.0.0 e 10.0.2.2 não foram usados."
record_check "Android por rede real com texto e imagem" "O Android completou texto e imagem usando LAN ou Tailscale, sem 10.0.2.2?"

stage "Reconectar depois de reiniciar"
say "Você observa a thread; o script reinicia automaticamente o dev runner capturado e espera o mesmo origin voltar."
step "Na thread web do segundo dispositivo, envie RESTART-BEFORE e aguarde a resposta final."
pause "Pressione Enter depois de enviar RESTART-BEFORE; o wizard fará o restart agora."
stop_web_runner
start_web_runner
wait_for_web_runner
note "web reiniciado no mesmo base-dir; origin novamente disponível em $WEB_SHARED_ORIGIN"
step "Volte à thread web existente, aguarde a reconexão e envie exatamente RECONNECT-OK. Não faça novo pairing."
pause "Pressione Enter depois que RECONNECT-OK terminar."
expected "a thread existente sincroniza sem mensagem duplicada, thread nova ou spinner permanente."
record_check "Reconexão e retomada do web" "A thread web existente voltou depois do restart sem duplicação ou estado preso?"

stage "Testar subagentes com o contrato real"
say "Esta etapa exige o Pi decidir e chamar ferramentas; não há comando de setup para o wizard executar."
step "Na thread principal Pi, peça exatamente estas operações e rejeite uma resposta que apenas descreva o que faria:"
prompt_line 'Use as ferramentas de subagentes, não apenas explique. Faça exatamente nesta ordem:'
prompt_line '1. subagent_spawn com name "cancel-me", harness "pi" e prompt "Execute bash -lc '\''tail -f /dev/null'\'' e permaneça bloqueado."'
prompt_line '2. subagent_spawn com name "finishes", harness "pi" e prompt "Responda exatamente SUBAGENT-B-OK e termine."'
prompt_line '3. Use subagent_list e registre os dois IDs e os status.'
prompt_line '4. Use subagent_check no ID cancel-me enquanto ele estiver running.'
prompt_line '5. Use subagent_cancel com o ID cancel-me.'
prompt_line '6. Use subagent_wait com o ID finishes e mostre o resultado final.'
step "Confirme que cancel-me foi cancelado, finishes terminou com SUBAGENT-B-OK, os resultados ficaram na thread principal e nenhum processo tail continua."
step "Repita somente para harnesses listados como disponíveis; registre incompatibilidades em vez de trocar silenciosamente o teste."
record_check "Controle completo de subagentes" "List, check, cancel e wait funcionaram com IDs reais e sem processo preso?"

stage "Medir imagem repetida e memória"
say "O monitor será iniciado pelo script; você só envia as imagens e observa respostas/ferramentas."
start_memory_monitor
note "Monitor somente leitura: $MEMORY_LOG"
step "Na thread Android validada, envie a mesma imagem pequena em três turnos separados, usando um prompt por vez:"
prompt_line 'Responda exatamente IMAGE-1-OK e não use ferramentas.'
prompt_line 'Responda exatamente IMAGE-2-OK e não use ferramentas.'
prompt_line 'Responda exatamente IMAGE-3-OK e não use ferramentas.'
pause "Pressione Enter depois que os três turnos terminarem; o monitor será encerrado e analisado automaticamente."
stop_memory_monitor
summarize_memory
env RUN_DIR="$MOBILE_RUN_DIR" "$MOBILE_HELPER" capture memory-after >/dev/null 2>&1 || true
step "Observe tempo percebido, ferramentas inesperadas e qualquer resposta perdida; o wizard não persiste texto livre para evitar guardar tokens por engano."
expected "os três turnos terminam, o RSS estabiliza e nenhum processo órfão aparece."
record_check "Imagem repetida sem crescimento persistente" "Os três turnos terminaram sem crescimento persistente de memória, contexto inesperado ou processo órfão?"

stage "Validar token expirado e recuperar pairing"
say "O script vai emitir o token curto e esperar a expiração; você só o usa em outro Add Environment e observa o erro."
issue_mobile_pairing 30s pi-mvp-expiring
step "Em outro aparelho, ou removendo temporariamente o ambiente de teste, preencha Add Environment com o Host $MOBILE_ORIGIN e o token acima. Não use a thread já pareada."
pause "Pressione Enter depois que o token curto tiver sido inserido no segundo pairing; o wizard aguardará 35 segundos."
say "Aguardando a expiração do token..."
for ((i = 35; i > 0; i -= 1)); do
  printf '\r  %s segundos restantes ' "$i"
  sleep 1
done
printf '\n'
step "Tente concluir o pairing com o token vencido. Não repita o token."
pause "Pressione Enter depois de observar a rejeição clara e sem ambiente parcialmente salvo."
expected "o token expirado é recusado claramente."
issue_mobile_pairing 15m pi-mvp-recovery
step "Use o token novo no mesmo Host, confirme o projeto, abra uma thread e envie TOKEN-RECOVERY-OK."
pause "Pressione Enter depois que TOKEN-RECOVERY-OK terminar."
expected "o token novo recupera o pairing e o turno termina normalmente."
record_check "Recuperação após token expirado" "O token vencido falhou claramente e um token novo recuperou o pairing?"

say "Coletando evidências e limpando automaticamente; não há comandos para copiar."
stop_memory_monitor
mobile_evidence_ok=1
collect_mobile_evidence || mobile_evidence_ok=0
mobile_cleanup_ok=1
cleanup_mobile || mobile_cleanup_ok=0
web_cleanup_ok=1
cleanup_web || web_cleanup_ok=0
if (( web_cleanup_ok == 1 && WEB_CLEANUP_OK == 1 )); then
  delete_web_base
else
  warn "base-dir web preservado porque o cleanup do runner/portas não foi comprovado"
  WEB_CLEANUP_OK=0
fi
if (( mobile_cleanup_ok == 1 && web_cleanup_ok == 1 && WEB_CLEANUP_OK == 1 )); then
  record_automatic_check "Cleanup sem processos, reverse ADB ou base ativos" PASS
else
  record_automatic_check "Cleanup sem processos, reverse ADB ou base ativos" PENDENTE
fi
if (( mobile_evidence_ok == 1 )); then
  record_automatic_check "Captura final e db-proof Android gerados" PASS
else
  record_automatic_check "Captura final e db-proof Android gerados" PENDENTE
fi
note "Evidência Android preservada em: $MOBILE_EVIDENCE_DIR"
record_automatic_check "Setup, doctor e projetos executados pelo wizard" PASS

finish_validation
