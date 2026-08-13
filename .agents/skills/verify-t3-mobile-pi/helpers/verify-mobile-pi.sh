#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DEFAULT_REPO_ROOT="$(cd -- "$SKILL_DIR/../../.." && pwd)"

REPO_ROOT="${REPO_ROOT:-$DEFAULT_REPO_ROOT}"
RUN_PARENT="${RUN_PARENT:-${TMPDIR:-/tmp}/t3-mobile-pi-verification}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
RUN_DIR="${RUN_DIR:-$RUN_PARENT/$RUN_ID}"
BASE_DIR="${BASE_DIR:-$RUN_DIR/base}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$RUN_DIR/evidence}"
STATE_FILE="${STATE_FILE:-$RUN_DIR/state.env}"
ANDROID_RUNTIME_STATE_FILE="${ANDROID_RUNTIME_STATE_FILE:-$RUN_DIR/android-runtime.env}"
LOG_DIR="${LOG_DIR:-$EVIDENCE_DIR/logs}"
SERVER_PORT="${SERVER_PORT:-14273}"
METRO_PORT="${METRO_PORT:-6233}"
METRO_CLEAR="${METRO_CLEAR:-0}"
REUSE_METRO="${REUSE_METRO:-1}"
ANDROID_RUNTIME_CACHE="${ANDROID_RUNTIME_CACHE:-${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/t3-mobile-pi/android}"
SERVER_BIND_HOST="${SERVER_BIND_HOST:-0.0.0.0}"
SERVER_LOCAL_ORIGIN="${SERVER_LOCAL_ORIGIN:-http://127.0.0.1:$SERVER_PORT}"
MOBILE_ORIGIN="${MOBILE_ORIGIN:-http://10.0.2.2:$SERVER_PORT}"
PROJECT_PATH="${PROJECT_PATH:-$REPO_ROOT}"
PROJECT_TITLE="${PROJECT_TITLE:-T3 Code Pi verification}"
ADB_SERIAL="${ADB_SERIAL:-}"
ADB_BIN="${ADB_BIN:-}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
ANDROID_SDK_HOME="${ANDROID_SDK_HOME:-}"
ANDROID_USER_HOME="${ANDROID_USER_HOME:-}"
ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-}"
ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-35}"
ANDROID_ABI="${ANDROID_ABI:-}"
ANDROID_AVD_NAME="${ANDROID_AVD_NAME:-}"
EMULATOR_BIN="${EMULATOR_BIN:-}"
EMULATOR_PID="${EMULATOR_PID:-}"
EMULATOR_OWNED="${EMULATOR_OWNED:-0}"
EMULATOR_PORT="${EMULATOR_PORT:-}"
APK_PATH="${APK_PATH:-}"
AUTO_BUILD_APK="${AUTO_BUILD_APK:-1}"
ADB_REVERSE="${ADB_REVERSE:-0}"
DEVICE_IMAGE_PATH="${DEVICE_IMAGE_PATH:-}"
METRO_OWNED="${METRO_OWNED:-1}"

die() {
  printf 'verify-t3-mobile-pi: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "comando ausente: $1"
}

resolve_adb_bin() {
  if [[ -n "$ADB_BIN" && -x "$ADB_BIN" ]]; then
    return 0
  fi
  if command -v adb >/dev/null 2>&1; then
    ADB_BIN="$(command -v adb)"
    return 0
  fi
  if [[ -n "$ANDROID_SDK_ROOT" && -x "$ANDROID_SDK_ROOT/platform-tools/adb" ]]; then
    ADB_BIN="$ANDROID_SDK_ROOT/platform-tools/adb"
    return 0
  fi
  return 1
}

adb_exec() {
  resolve_adb_bin || die 'adb não está disponível'
  "$ADB_BIN" "$@"
}

require_android_device() {
  resolve_adb_bin || die 'adb não está disponível; use launch para provisionar o runtime Android'
  [[ -n "$ADB_SERIAL" ]] || die 'defina ADB_SERIAL com um emulador Android já iniciado'
  [[ "$(adb_exec -s "$ADB_SERIAL" get-state 2>/dev/null || true)" == 'device' ]] || \
    die "ADB_SERIAL não está online como device: $ADB_SERIAL"
}

ensure_layout() {
  mkdir -p -- "$RUN_DIR" "$EVIDENCE_DIR" "$LOG_DIR"
}

write_state() {
  ensure_layout
  local temporary_state="$STATE_FILE.tmp.$$"
  {
    printf 'RUN_DIR=%q\n' "$RUN_DIR"
    printf 'REPO_ROOT=%q\n' "$REPO_ROOT"
    printf 'BASE_DIR=%q\n' "$BASE_DIR"
    printf 'EVIDENCE_DIR=%q\n' "$EVIDENCE_DIR"
    printf 'STATE_FILE=%q\n' "$STATE_FILE"
    printf 'ANDROID_RUNTIME_STATE_FILE=%q\n' "$ANDROID_RUNTIME_STATE_FILE"
    printf 'LOG_DIR=%q\n' "$LOG_DIR"
    printf 'SERVER_PORT=%q\n' "$SERVER_PORT"
    printf 'METRO_PORT=%q\n' "$METRO_PORT"
    printf 'METRO_CLEAR=%q\n' "$METRO_CLEAR"
    printf 'REUSE_METRO=%q\n' "$REUSE_METRO"
    printf 'SERVER_BIND_HOST=%q\n' "$SERVER_BIND_HOST"
    printf 'SERVER_LOCAL_ORIGIN=%q\n' "$SERVER_LOCAL_ORIGIN"
    printf 'MOBILE_ORIGIN=%q\n' "$MOBILE_ORIGIN"
    printf 'PROJECT_PATH=%q\n' "$PROJECT_PATH"
    printf 'PROJECT_TITLE=%q\n' "$PROJECT_TITLE"
    printf 'AUTO_BUILD_APK=%q\n' "$AUTO_BUILD_APK"
    printf 'ANDROID_RUNTIME_CACHE=%q\n' "$ANDROID_RUNTIME_CACHE"
    printf 'ANDROID_SDK_ROOT=%q\n' "$ANDROID_SDK_ROOT"
    printf 'ANDROID_SDK_HOME=%q\n' "$ANDROID_SDK_HOME"
    printf 'ANDROID_USER_HOME=%q\n' "$ANDROID_USER_HOME"
    printf 'ANDROID_AVD_HOME=%q\n' "$ANDROID_AVD_HOME"
    printf 'ANDROID_API_LEVEL=%q\n' "$ANDROID_API_LEVEL"
    printf 'ANDROID_ABI=%q\n' "$ANDROID_ABI"
    printf 'ANDROID_AVD_NAME=%q\n' "$ANDROID_AVD_NAME"
    printf 'ADB_BIN=%q\n' "$ADB_BIN"
    printf 'ADB_SERIAL=%q\n' "$ADB_SERIAL"
    printf 'APK_PATH=%q\n' "$APK_PATH"
    printf 'EMULATOR_BIN=%q\n' "$EMULATOR_BIN"
    printf 'EMULATOR_PID=%q\n' "$EMULATOR_PID"
    printf 'EMULATOR_OWNED=%q\n' "$EMULATOR_OWNED"
    printf 'EMULATOR_PORT=%q\n' "$EMULATOR_PORT"
    printf 'ADB_REVERSE=%q\n' "$ADB_REVERSE"
    printf 'DEVICE_IMAGE_PATH=%q\n' "$DEVICE_IMAGE_PATH"
    printf 'BACKEND_PID=%q\n' "${BACKEND_PID:-}"
    printf 'METRO_PID=%q\n' "${METRO_PID:-}"
    printf 'METRO_OWNED=%q\n' "${METRO_OWNED:-1}"
  } > "$temporary_state"
  mv -- "$temporary_state" "$STATE_FILE"
}

load_state() {
  [[ -f "$STATE_FILE" ]] || die "estado ausente: $STATE_FILE (passe RUN_DIR do launch)"
  # shellcheck disable=SC1090
  source "$STATE_FILE"
}

process_command() {
  local pid="$1"
  if [[ -r "/proc/$pid/cmdline" ]]; then
    tr '\0' ' ' < "/proc/$pid/cmdline"
  else
    ps -p "$pid" -o command= 2>/dev/null || true
  fi
}

process_cwd() {
  local pid="$1"
  if [[ -e "/proc/$pid/cwd" ]]; then
    readlink -f "/proc/$pid/cwd"
  else
    ps -p "$pid" -o lstart= 2>/dev/null || true
  fi
}

stop_process_group() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  kill -INT -- "-$pid" 2>/dev/null || kill -INT "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  printf 'verify-t3-mobile-pi: processo não encerrou após SIGTERM: %s\n' "$pid" >&2
  return 1
}

cleanup_impl() {
  set +e
  if [[ -n "${ADB_SERIAL:-}" ]] && resolve_adb_bin; then
    if [[ -n "${DEVICE_IMAGE_PATH:-}" ]]; then
      adb_exec -s "$ADB_SERIAL" shell rm -f -- "$DEVICE_IMAGE_PATH" >/dev/null 2>&1 || true
    fi
    if [[ "${ADB_REVERSE:-0}" == '1' ]]; then
      adb_exec -s "$ADB_SERIAL" reverse --remove "tcp:$METRO_PORT" >/dev/null 2>&1 || true
    fi
  fi

  if [[ "${EMULATOR_OWNED:-0}" == '1' ]]; then
    stop_process_group "${EMULATOR_PID:-}" || true
  fi
  if [[ "${METRO_OWNED:-1}" == '1' ]]; then
    stop_process_group "${METRO_PID:-}" || true
  fi
  stop_process_group "${BACKEND_PID:-}" || true

  case "$BASE_DIR" in
    "$RUN_DIR"/*)
      rm -rf -- "$BASE_DIR"
      ;;
    *)
      printf 'verify-t3-mobile-pi: base externo preservado: %s\n' "$BASE_DIR" >&2
      ;;
  esac
  rm -f -- "$STATE_FILE"
  rm -f -- "$ANDROID_RUNTIME_STATE_FILE"
}

wait_for_url() {
  local url="$1"
  local output="$2"
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 2 "$url" > "$output" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

find_apk() {
  local candidate
  if [[ -n "$APK_PATH" && -f "$APK_PATH" ]]; then
    printf '%s\n' "$APK_PATH"
    return 0
  fi
  for candidate in \
    "$REPO_ROOT/apps/mobile/android/app/build/outputs/apk/development/debug/app-development-debug.apk" \
    "$REPO_ROOT/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  find "${TMPDIR:-/tmp}" -maxdepth 8 -path '*/eas-build-run-cache/*.apk' -type f -print 2>/dev/null | sort | tail -1
}

ensure_apk() {
  local discovered
  discovered="$(find_apk || true)"
  if [[ -n "$discovered" ]]; then
    APK_PATH="$discovered"
    return 0
  fi
  if adb_exec -s "$ADB_SERIAL" shell pm path com.t3tools.t3code.dev >/dev/null 2>&1; then
    printf 'verify-t3-mobile-pi: dev client já instalado em %s\n' "$ADB_SERIAL" >> "$LOG_DIR/mobile-build.log"
    APK_PATH=''
    return 0
  fi
  [[ "$AUTO_BUILD_APK" == '1' ]] || die 'APK ausente e AUTO_BUILD_APK=0; forneça APK_PATH'

  local log_dir="$LOG_DIR"
  mkdir -p -- "$log_dir"
  printf 'verify-t3-mobile-pi: APK não encontrado; construindo o dev client em cache\n' \
    > "$log_dir/mobile-build.log"
  (
    cd -- "$REPO_ROOT/apps/mobile"
    export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"
    export ANDROID_HOME="$ANDROID_SDK_ROOT" ANDROID_SDK_ROOT
    pnpm exec expo run:android \
      --variant development \
      --no-bundler \
      --no-install \
      --device "$ADB_SERIAL"
  ) >> "$log_dir/mobile-build.log" 2>&1 ||
    die "o build automático do APK falhou; veja $log_dir/mobile-build.log"

  APK_PATH="$(find_apk || true)"
  if [[ -z "$APK_PATH" ]]; then
    printf 'APK instalado pelo Expo; nenhuma cópia local foi encontrada\n' \
      >> "$log_dir/mobile-build.log"
  fi
}

configure_pi() {
  mkdir -p -- "$BASE_DIR/userdata"
  PI_SETTINGS_PATH="$BASE_DIR/userdata/settings.json" node -e '
    const fs = require("node:fs");
    const path = process.env.PI_SETTINGS_PATH;
    fs.writeFileSync(path, JSON.stringify({
      providerInstances: { pi: { driver: "pi", enabled: true, config: {} } },
    }, null, 2) + "\n");
  '
}

launch() {
  require_command node
  require_command pnpm
  require_command curl
  [[ -d "$REPO_ROOT/apps/mobile" ]] || die "apps/mobile não existe em REPO_ROOT: $REPO_ROOT"
  [[ -d "$PROJECT_PATH/.git" ]] || die "PROJECT_PATH precisa ser um checkout Git: $PROJECT_PATH"
  [[ ! -e "$STATE_FILE" ]] || die "já existe um run em $RUN_DIR; rode cleanup antes de reutilizar"

  ensure_layout
  trap 'cleanup_impl' EXIT
  REPO_ROOT="$REPO_ROOT" \
    RUN_DIR="$RUN_DIR" \
    EVIDENCE_DIR="$EVIDENCE_DIR" \
    RUNTIME_STATE_FILE="$ANDROID_RUNTIME_STATE_FILE" \
    ANDROID_RUNTIME_CACHE="$ANDROID_RUNTIME_CACHE" \
    ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT" \
    ANDROID_SDK_HOME="$ANDROID_SDK_HOME" \
    ANDROID_USER_HOME="$ANDROID_USER_HOME" \
    ANDROID_AVD_HOME="$ANDROID_AVD_HOME" \
    ANDROID_API_LEVEL="$ANDROID_API_LEVEL" \
    ANDROID_ABI="$ANDROID_ABI" \
    ANDROID_AVD_NAME="$ANDROID_AVD_NAME" \
    ADB_SERIAL="$ADB_SERIAL" \
    ADB_BIN="$ADB_BIN" \
    EMULATOR_BIN="$EMULATOR_BIN" \
    EMULATOR_PID="$EMULATOR_PID" \
    EMULATOR_OWNED="$EMULATOR_OWNED" \
    EMULATOR_PORT="$EMULATOR_PORT" \
    REUSE_ANDROID_DEVICE="${REUSE_ANDROID_DEVICE:-0}" \
    ANDROID_BOOT_TIMEOUT="${ANDROID_BOOT_TIMEOUT:-180}" \
    ANDROID_EMULATOR_HEADLESS="${ANDROID_EMULATOR_HEADLESS:-1}" \
    ANDROID_COLD_BOOT="${ANDROID_COLD_BOOT:-0}" \
    "$SCRIPT_DIR/android-runtime.sh" ensure
  # shellcheck disable=SC1090
  source "$ANDROID_RUNTIME_STATE_FILE"
  ensure_apk
  write_state
  configure_pi
  node "$REPO_ROOT/apps/server/src/bin.ts" project add "$PROJECT_PATH" \
    --base-dir "$BASE_DIR" \
    --title "$PROJECT_TITLE" > "$EVIDENCE_DIR/project-add.log" 2>&1

  if [[ -n "$APK_PATH" ]]; then
    [[ -f "$APK_PATH" ]] || die "APK_PATH não existe: $APK_PATH"
    adb_exec -s "$ADB_SERIAL" install -r "$APK_PATH" > "$EVIDENCE_DIR/apk-install.log" 2>&1
  fi

  (
    cd -- "$REPO_ROOT"
    exec setsid node apps/server/src/bin.ts serve \
      --host "$SERVER_BIND_HOST" \
      --port "$SERVER_PORT" \
      --base-dir "$BASE_DIR" \
      --no-browser
  ) > "$LOG_DIR/backend.log" 2>&1 &
  BACKEND_PID=$!

  METRO_PID=''
  METRO_OWNED=0
  if [[ "$REUSE_METRO" == '1' ]] && curl -fsS "http://127.0.0.1:$METRO_PORT/status" > "$EVIDENCE_DIR/metro-reused-status.txt" 2>/dev/null; then
    require_command ss
    metro_listener_pid="$(ss -H -ltnp "sport = :$METRO_PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)"
    [[ "$metro_listener_pid" =~ ^[0-9]+$ ]] || die "Metro responde, mas o dono da porta $METRO_PORT não foi identificado"
    metro_listener_cwd="$(process_cwd "$metro_listener_pid")"
    metro_listener_cmd="$(process_command "$metro_listener_pid")"
    [[ "$metro_listener_cwd" == "$REPO_ROOT/apps/mobile" ]] || \
      die "Metro saudável pertence a outro checkout: $metro_listener_cwd"
    [[ "$metro_listener_cmd" == *'expo start'* && "$metro_listener_cmd" == *'--dev-client'* && "$metro_listener_cmd" == *'t3code-dev'* ]] || \
      die "Metro saudável não tem a identidade development/dev-client esperada"
    METRO_PID="$metro_listener_pid"
    printf 'Metro reutilizado pid=%s cwd=%s cmd=%s\n' "$METRO_PID" "$metro_listener_cwd" "$metro_listener_cmd" > "$EVIDENCE_DIR/metro-reused.txt"
  else
    metro_args=(start --dev-client --scheme t3code-dev --lan --port "$METRO_PORT")
    if [[ "$METRO_CLEAR" == '1' ]]; then
      metro_args+=(--clear)
    fi
    (
      cd -- "$REPO_ROOT/apps/mobile"
      exec setsid env APP_VARIANT=development pnpm exec expo "${metro_args[@]}"
    ) > "$LOG_DIR/metro.log" 2>&1 &
    METRO_PID=$!
    METRO_OWNED=1
  fi

  write_state

  wait_for_url "$SERVER_LOCAL_ORIGIN/.well-known/t3/environment" "$EVIDENCE_DIR/server-environment.json" || \
    die "backend não respondeu; veja $LOG_DIR/backend.log"
  wait_for_url "http://127.0.0.1:$METRO_PORT/status" "$EVIDENCE_DIR/metro-status.txt" || \
    die "Metro não respondeu; veja $LOG_DIR/metro.log"

  adb_exec -s "$ADB_SERIAL" reverse "tcp:$METRO_PORT" "tcp:$METRO_PORT"
  ADB_REVERSE=1
  write_state
  trap - EXIT

  printf 'RUN_DIR=%s\n' "$RUN_DIR"
  printf 'STATE_FILE=%s\n' "$STATE_FILE"
  printf 'BASE_DIR=%s\n' "$BASE_DIR"
  printf 'EVIDENCE_DIR=%s\n' "$EVIDENCE_DIR"
  printf 'SERVER_LOCAL_ORIGIN=%s\n' "$SERVER_LOCAL_ORIGIN"
  printf 'MOBILE_ORIGIN=%s\n' "$MOBILE_ORIGIN"
  printf 'METRO_URL=t3code-dev://expo-development-client/?url=http%%3A%%2F%%2F127.0.0.1%%3A%s\n' "$METRO_PORT"
  printf 'Próximo passo: source %q e emitir um pairing token sem salvá-lo em evidência.\n' "$STATE_FILE"
}

doctor_body() {
  local backend_cwd metro_cwd
  [[ -f "$BASE_DIR/userdata/state.sqlite" ]] || die "state.sqlite ausente: $BASE_DIR/userdata/state.sqlite"
  [[ "${BACKEND_PID:-}" =~ ^[0-9]+$ ]] || die 'BACKEND_PID ausente no estado'
  [[ "${METRO_PID:-}" =~ ^[0-9]+$ ]] || die 'METRO_PID ausente no estado'
  kill -0 "$BACKEND_PID" 2>/dev/null || die "backend parado: $BACKEND_PID"
  kill -0 "$METRO_PID" 2>/dev/null || die "Metro parado: $METRO_PID"
  if [[ "${EMULATOR_OWNED:-0}" == '1' ]]; then
    kill -0 "$EMULATOR_PID" 2>/dev/null || die "emulador parado: $EMULATOR_PID"
  fi

  backend_cwd="$(process_cwd "$BACKEND_PID")"
  metro_cwd="$(process_cwd "$METRO_PID")"
  [[ "$backend_cwd" == "$REPO_ROOT" ]] || die "backend não pertence ao checkout: $backend_cwd"
  [[ "$metro_cwd" == "$REPO_ROOT/apps/mobile" ]] || die "Metro não pertence ao checkout: $metro_cwd"

  printf 'backend pid=%s cwd=%s cmd=%s\n' "$BACKEND_PID" "$backend_cwd" "$(process_command "$BACKEND_PID")"
  printf 'metro pid=%s owned=%s cwd=%s cmd=%s\n' "$METRO_PID" "${METRO_OWNED:-1}" "$metro_cwd" "$(process_command "$METRO_PID")"
  printf 'android sdk=%s adb=%s serial=%s avd=%s owned=%s\n' \
    "$ANDROID_SDK_ROOT" "$ADB_BIN" "$ADB_SERIAL" "$ANDROID_AVD_NAME" "${EMULATOR_OWNED:-0}"
  printf 'server='; curl -fsS "$SERVER_LOCAL_ORIGIN/.well-known/t3/environment" | tr -d '\n'; printf '\n'
  printf 'metro='; curl -fsS "http://127.0.0.1:$METRO_PORT/status" | tr -d '\n'; printf '\n'

  PI_SETTINGS_PATH="$BASE_DIR/userdata/settings.json" node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.env.PI_SETTINGS_PATH, "utf8"));
    if (value.providerInstances?.pi?.driver !== "pi" || value.providerInstances?.pi?.enabled !== true) {
      throw new Error("providerInstances.pi não está habilitado");
    }
    console.log("pi-settings=enabled");
  '
  printf 'pi-version='; pi --version

  require_android_device
  adb_exec -s "$ADB_SERIAL" shell pm path com.t3tools.t3code.dev
  if [[ "${ADB_REVERSE:-0}" == '1' ]]; then
    adb_exec -s "$ADB_SERIAL" reverse --list | grep -F "tcp:$METRO_PORT" >/dev/null || \
      die "reverse ADB ausente para Metro: tcp:$METRO_PORT"
    printf 'adb-reverse=tcp:%s\n' "$METRO_PORT"
  fi
}

doctor() {
  load_state
  ensure_layout
  doctor_body 2>&1 | tee "$EVIDENCE_DIR/doctor.txt"
}

capture() {
  load_state
  require_android_device
  local label="${1:-current}"
  [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || die "label inválido: $label"
  local remote_xml="/sdcard/t3-verify-$label.xml"
  adb_exec -s "$ADB_SERIAL" shell uiautomator dump "$remote_xml" >/dev/null
  adb_exec -s "$ADB_SERIAL" exec-out cat "$remote_xml" > "$EVIDENCE_DIR/$label.ui.xml"
  adb_exec -s "$ADB_SERIAL" exec-out screencap -p > "$EVIDENCE_DIR/$label.png"
  adb_exec -s "$ADB_SERIAL" shell rm -f -- "$remote_xml" >/dev/null
  printf 'ui=%s\nscreenshot=%s\n' "$EVIDENCE_DIR/$label.ui.xml" "$EVIDENCE_DIR/$label.png"
}

prepare_image() {
  load_state
  require_android_device
  local source="${1:-$REPO_ROOT/apps/mobile/assets/android-icon-mark.png}"
  [[ -f "$source" ]] || die "imagem ausente: $source"
  DEVICE_IMAGE_PATH='/sdcard/Pictures/t3-wayfinder.png'
  adb_exec -s "$ADB_SERIAL" shell mkdir -p /sdcard/Pictures >/dev/null
  adb_exec -s "$ADB_SERIAL" push "$source" "$DEVICE_IMAGE_PATH" > "$EVIDENCE_DIR/image-push.log"
  adb_exec -s "$ADB_SERIAL" shell am broadcast \
    -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
    -d "file://$DEVICE_IMAGE_PATH" >/dev/null
  write_state
  printf 'device-image=%s\n' "$DEVICE_IMAGE_PATH"
}

db_proof() {
  load_state
  [[ -f "$BASE_DIR/userdata/state.sqlite" ]] || die "state.sqlite ausente: $BASE_DIR/userdata/state.sqlite"
  {
    printf '%s\n' '# threads and model selection (no message bodies)'
    node "$REPO_ROOT/apps/server/scripts/t3-sqlite-state.ts" query --base-dir "$BASE_DIR" \
      --sql "SELECT thread_id, title, substr(model_selection_json, 1, 200) AS model_selection FROM projection_threads WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    printf '%s\n' '# message counts and image attachment counts'
    node "$REPO_ROOT/apps/server/scripts/t3-sqlite-state.ts" query --base-dir "$BASE_DIR" \
      --sql "SELECT thread_id, COUNT(*) AS messages, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_messages, SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages, SUM(CASE WHEN attachments_json IS NOT NULL AND attachments_json <> '[]' THEN 1 ELSE 0 END) AS messages_with_attachments FROM projection_thread_messages GROUP BY thread_id"
    printf '%s\n' '# turn lifecycle'
    node "$REPO_ROOT/apps/server/scripts/t3-sqlite-state.ts" query --base-dir "$BASE_DIR" \
      --sql "SELECT thread_id, state, started_at, completed_at FROM projection_turns ORDER BY row_id DESC"
    printf '%s\n' '# visible tool/interrupt activities'
    node "$REPO_ROOT/apps/server/scripts/t3-sqlite-state.ts" query --base-dir "$BASE_DIR" \
      --sql "SELECT thread_id, kind, summary FROM projection_thread_activities WHERE lower(summary) LIKE '%subagent%' OR lower(summary) LIKE '%preview%' OR lower(summary) LIKE '%interrupt%' OR lower(summary) LIKE '%abort%' ORDER BY created_at"
    printf '%s\n' '# Pi RPC names observed in session JSONL'
    if [[ -d "$BASE_DIR/userdata/pi/pi" ]]; then
      find "$BASE_DIR/userdata/pi/pi" -type f -name '*.jsonl' -print0 |
        while IFS= read -r -d '' file; do
          rg -o '"(toolName|name|command)":"(subagent_spawn|subagent_wait|t3_preview_status)"' "$file" || true
        done | sort -u
    fi
  } | tee "$EVIDENCE_DIR/db-proof.txt"
}

show_env() {
  load_state
  printf 'RUN_DIR=%q\n' "$RUN_DIR"
  printf 'STATE_FILE=%q\n' "$STATE_FILE"
  printf 'BASE_DIR=%q\n' "$BASE_DIR"
  printf 'EVIDENCE_DIR=%q\n' "$EVIDENCE_DIR"
  printf 'SERVER_PORT=%q\n' "$SERVER_PORT"
  printf 'METRO_PORT=%q\n' "$METRO_PORT"
  printf 'METRO_CLEAR=%q\n' "$METRO_CLEAR"
  printf 'REUSE_METRO=%q\n' "$REUSE_METRO"
  printf 'MOBILE_ORIGIN=%q\n' "$MOBILE_ORIGIN"
  printf 'ADB_SERIAL=%q\n' "$ADB_SERIAL"
}

cleanup() {
  load_state
  local cleanup_report="$EVIDENCE_DIR/cleanup.txt"
  cleanup_impl
  {
    printf 'evidence=%s\n' "$EVIDENCE_DIR"
    printf 'android_emulator_stopped=%s\n' "${EMULATOR_OWNED:-0}"
    printf 'backend_stopped=%s\n' "$BACKEND_PID"
    printf 'metro_stopped=%s\n' "$METRO_PID"
    printf 'state_removed=%s\n' "$STATE_FILE"
  } | tee "$cleanup_report"
}

usage() {
  cat >&2 <<'EOF'
Uso: verify-mobile-pi.sh <launch|doctor|capture|prepare-image|db-proof|env|cleanup>

launch       provisiona/reusa Android, garante o dev client, inicia backend + Metro em estado isolado
doctor       valida processos, checkout, endpoints, Pi, APK e reverse ADB
capture      salva hierarquia uiautomator e screenshot; recebe um label opcional
prepare-image envia a imagem de fixture para /sdcard/Pictures e registra o caminho para cleanup
db-proof     salva contagens SQLite e nomes de RPC sem corpos de mensagens
env          imprime variáveis do run para `eval` ou `source`
cleanup      remove reverse ADB, processos capturados, base temporária e imagem do device; preserva evidência
EOF
}

case "${1:-}" in
  launch) launch ;;
  doctor) doctor ;;
  capture) shift; capture "${1:-current}" ;;
  prepare-image) shift; prepare_image "${1:-}" ;;
  db-proof) db_proof ;;
  env) show_env ;;
  cleanup) cleanup ;;
  *) usage; exit 2 ;;
esac
