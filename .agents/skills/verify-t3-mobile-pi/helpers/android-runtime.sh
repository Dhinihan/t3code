#!/usr/bin/env bash
set -Eeuo pipefail

# Provision only the Android pieces this verification needs. The SDK and AVD
# live in a user cache so the first run pays the download cost and later runs
# reuse it without modifying the checkout.

RUN_DIR="${RUN_DIR:?RUN_DIR is required}"
EVIDENCE_DIR="${EVIDENCE_DIR:?EVIDENCE_DIR is required}"
RUNTIME_STATE_FILE="${RUNTIME_STATE_FILE:?RUNTIME_STATE_FILE is required}"

default_cache_dir() {
  printf '%s\n' "${ANDROID_RUNTIME_CACHE:-${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/t3-mobile-pi/android}"
}

ANDROID_RUNTIME_CACHE="${ANDROID_RUNTIME_CACHE:-$(default_cache_dir)}"
ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-35}"
ANDROID_ABI="${ANDROID_ABI:-}"
ANDROID_AVD_NAME="${ANDROID_AVD_NAME:-}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
ANDROID_SDK_HOME="${ANDROID_SDK_HOME:-$ANDROID_RUNTIME_CACHE/user}"
ANDROID_USER_HOME="${ANDROID_USER_HOME:-$ANDROID_RUNTIME_CACHE/user}"
ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$ANDROID_RUNTIME_CACHE/avd}"
ANDROID_BOOT_TIMEOUT="${ANDROID_BOOT_TIMEOUT:-180}"
ANDROID_EMULATOR_HEADLESS="${ANDROID_EMULATOR_HEADLESS:-1}"
ANDROID_COLD_BOOT="${ANDROID_COLD_BOOT:-0}"
REUSE_ANDROID_DEVICE="${REUSE_ANDROID_DEVICE:-0}"
ADB_SERIAL="${ADB_SERIAL:-}"
ADB_BIN="${ADB_BIN:-}"
EMULATOR_BIN="${EMULATOR_BIN:-}"
AVDMANAGER_BIN="${AVDMANAGER_BIN:-}"
SDKMANAGER_BIN="${SDKMANAGER_BIN:-}"
EMULATOR_PID="${EMULATOR_PID:-}"
EMULATOR_OWNED="${EMULATOR_OWNED:-0}"
EMULATOR_PORT="${EMULATOR_PORT:-}"

if [[ -z "$ANDROID_ABI" ]]; then
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64) ANDROID_ABI='arm64-v8a' ;;
    *) ANDROID_ABI='x86_64' ;;
  esac
fi
ANDROID_AVD_NAME="${ANDROID_AVD_NAME:-t3-pi-api${ANDROID_API_LEVEL}-${ANDROID_ABI}}"
SYSTEM_IMAGE="system-images;android-${ANDROID_API_LEVEL};google_apis;${ANDROID_ABI}"

log() {
  printf 'verify-t3-mobile-pi: %s\n' "$*"
}

die() {
  printf 'verify-t3-mobile-pi: %s\n' "$*" >&2
  exit 1
}

stop_runtime_emulator() {
  local pid="${EMULATOR_PID:-}"
  [[ "${EMULATOR_OWNED:-0}" == '1' && "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -INT -- "-$pid" 2>/dev/null || kill -INT "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
}

runtime_exit_cleanup() {
  local status="$?"
  if [[ "$status" != '0' ]]; then
    stop_runtime_emulator
  fi
  return "$status"
}

trap 'runtime_exit_cleanup' EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "comando ausente para provisionar Android: $1"
}

verify_sha256() {
  local expected="$1"
  local file="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$expected" "$file" | sha256sum -c - >/dev/null
    return $?
  fi
  if command -v shasum >/dev/null 2>&1; then
    [[ "$(shasum -a 256 "$file" | awk '{print $1}')" == "$expected" ]]
    return $?
  fi
  die 'nenhum verificador SHA-256 disponível (sha256sum ou shasum)'
}

host_key() {
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) printf '%s\n' linux_x86_64 ;;
    Darwin:arm64) printf '%s\n' mac_arm64 ;;
    Darwin:x86_64) printf '%s\n' mac_x86_64 ;;
    *) die "plataforma Android não suportada automaticamente: $(uname -s) $(uname -m)" ;;
  esac
}

candidate_sdk_roots() {
  local home_dir="${HOME:-}"
  [[ -n "$ANDROID_SDK_ROOT" ]] && printf '%s\n' "$ANDROID_SDK_ROOT"
  [[ -n "${ANDROID_HOME:-}" && "${ANDROID_HOME:-}" != "$ANDROID_SDK_ROOT" ]] &&
    printf '%s\n' "$ANDROID_HOME"
  if [[ "$(uname -s)" == 'Darwin' ]]; then
    [[ -n "$home_dir" ]] && printf '%s\n' "$home_dir/Library/Android/sdk"
  else
    [[ -n "$home_dir" ]] && printf '%s\n' "$home_dir/Android/Sdk"
  fi
  printf '%s\n' "$ANDROID_RUNTIME_CACHE/sdk"
}

choose_sdk_root() {
  local candidate
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if [[ -x "$candidate/platform-tools/adb" || -x "$candidate/emulator/emulator" ||
      -x "$candidate/cmdline-tools/latest/bin/sdkmanager" || -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(candidate_sdk_roots)
  printf '%s\n' "$ANDROID_RUNTIME_CACHE/sdk"
}

find_tool() {
  local tool_name="$1"
  local root="$2"
  local candidate
  if [[ -n "${!tool_name:-}" && -x "${!tool_name}" ]]; then
    printf '%s\n' "${!tool_name}"
    return 0
  fi
  case "$tool_name" in
    ADB_BIN) command -v adb >/dev/null 2>&1 && command -v adb && return 0 ;;
    EMULATOR_BIN) command -v emulator >/dev/null 2>&1 && command -v emulator && return 0 ;;
    AVDMANAGER_BIN) command -v avdmanager >/dev/null 2>&1 && command -v avdmanager && return 0 ;;
    SDKMANAGER_BIN) command -v sdkmanager >/dev/null 2>&1 && command -v sdkmanager && return 0 ;;
  esac
  case "$tool_name" in
    ADB_BIN)
      candidate="$root/platform-tools/adb"
      [[ -x "$candidate" ]] && printf '%s\n' "$candidate" && return 0
      ;;
    EMULATOR_BIN)
      candidate="$root/emulator/emulator"
      [[ -x "$candidate" ]] && printf '%s\n' "$candidate" && return 0
      ;;
    AVDMANAGER_BIN|SDKMANAGER_BIN)
      local command_name="${tool_name%_BIN}"
      command_name="$(printf '%s' "$command_name" | tr '[:upper:]' '[:lower:]')"
      while IFS= read -r candidate; do
        [[ -x "$candidate" ]] && printf '%s\n' "$candidate" && return 0
      done < <(find "$root/cmdline-tools" -type f -path "*/bin/$command_name" -print 2>/dev/null | sort -r)
      ;;
  esac
  return 1
}

resolve_adb() {
  ADB_BIN="$(find_tool ADB_BIN "$ANDROID_SDK_ROOT" || true)"
  [[ -n "$ADB_BIN" ]] || return 1
}

resolve_sdk_tools() {
  EMULATOR_BIN="$(find_tool EMULATOR_BIN "$ANDROID_SDK_ROOT" || true)"
  AVDMANAGER_BIN="$(find_tool AVDMANAGER_BIN "$ANDROID_SDK_ROOT" || true)"
  SDKMANAGER_BIN="$(find_tool SDKMANAGER_BIN "$ANDROID_SDK_ROOT" || true)"
}

runtime_log() {
  mkdir -p -- "$EVIDENCE_DIR/logs"
  printf '%s/logs/android-runtime.log\n' "$EVIDENCE_DIR"
}

download_cmdline_tools() {
  require_command curl
  require_command unzip

  local version="${ANDROID_CMDLINE_TOOLS_VERSION:-15859902}"
  local platform="$(host_key)"
  local url="${ANDROID_CMDLINE_TOOLS_URL:-}"
  local sha256="${ANDROID_CMDLINE_TOOLS_SHA256:-}"
  case "$platform" in
    linux_x86_64)
      url="${url:-https://dl.google.com/android/repository/commandlinetools-linux-${version}_latest.zip}"
      sha256="${sha256:-4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583}"
      ;;
    mac_arm64)
      url="${url:-https://dl.google.com/android/repository/commandlinetools-mac_arm64-${version}_latest.zip}"
      sha256="${sha256:-835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e}"
      ;;
    mac_x86_64)
      url="${url:-https://dl.google.com/android/repository/commandlinetools-mac_x86_64-${version}_latest.zip}"
      sha256="${sha256:-c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3}"
      ;;
  esac

  local download_dir="$ANDROID_RUNTIME_CACHE/downloads"
  local archive="$download_dir/commandlinetools-${platform}-${version}.zip"
  mkdir -p -- "$download_dir"

  if ! verify_sha256 "$sha256" "$archive" >/dev/null 2>&1; then
    local partial="$archive.partial.$$"
    rm -f -- "$partial"
    log "baixando command-line tools Android uma vez para $ANDROID_RUNTIME_CACHE"
    if ! curl --fail --location --retry 3 --output "$partial" "$url"; then
      rm -f -- "$partial"
      die "download dos command-line tools falhou: $url"
    fi
    if ! verify_sha256 "$sha256" "$partial"; then
      rm -f -- "$partial"
      die "checksum inválido para os command-line tools: $url"
    fi
    mv -- "$partial" "$archive"
  fi

  local target="$ANDROID_SDK_ROOT/cmdline-tools/latest"
  if [[ ! -x "$target/bin/sdkmanager" ]]; then
    local extraction
    extraction="$(mktemp -d "$ANDROID_RUNTIME_CACHE/cmdline-tools.XXXXXX")"
    if ! unzip -q "$archive" -d "$extraction"; then
      rm -rf -- "$extraction"
      die "não foi possível extrair os command-line tools: $archive"
    fi
    mkdir -p -- "$ANDROID_SDK_ROOT/cmdline-tools"
    rm -rf -- "$target"
    mv -- "$extraction/cmdline-tools" "$target"
    rm -rf -- "$extraction"
  fi
  SDKMANAGER_BIN="$target/bin/sdkmanager"
  AVDMANAGER_BIN="$target/bin/avdmanager"
}

install_sdk_packages() {
  local log_file
  log_file="$(runtime_log)"
  mkdir -p -- "$ANDROID_SDK_ROOT" "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"
  export ANDROID_HOME="$ANDROID_SDK_ROOT"
  export ANDROID_SDK_ROOT ANDROID_SDK_HOME ANDROID_USER_HOME ANDROID_AVD_HOME

  if [[ ! -x "$SDKMANAGER_BIN" ]]; then
    log "preparando command-line tools Android (cache: $ANDROID_RUNTIME_CACHE)"
    download_cmdline_tools >>"$log_file" 2>&1
  fi
  [[ -x "$SDKMANAGER_BIN" ]] || die "sdkmanager não foi instalado em $ANDROID_SDK_ROOT"

  log "garantindo platform-tools, emulator e $SYSTEM_IMAGE (o cache acelera os próximos runs)"
  log "aceitando licenças Android e garantindo platform-tools/emulator/system image" >>"$log_file"
  set +o pipefail
  yes | "$SDKMANAGER_BIN" --sdk_root="$ANDROID_SDK_ROOT" --licenses >>"$log_file" 2>&1
  local license_status="${PIPESTATUS[1]}"
  set -o pipefail
  [[ "$license_status" == '0' ]] || die "sdkmanager --licenses falhou; veja $log_file"

  "$SDKMANAGER_BIN" --sdk_root="$ANDROID_SDK_ROOT" \
    platform-tools emulator "$SYSTEM_IMAGE" >>"$log_file" 2>&1 ||
    die "sdkmanager não conseguiu instalar o runtime Android; veja $log_file"
}

ensure_sdk() {
  ANDROID_SDK_ROOT="$(choose_sdk_root)"
  resolve_sdk_tools
  if [[ -x "$ANDROID_SDK_ROOT/platform-tools/adb" &&
    -x "$ANDROID_SDK_ROOT/emulator/emulator" &&
    -d "$ANDROID_SDK_ROOT/system-images/android-${ANDROID_API_LEVEL}/google_apis/${ANDROID_ABI}" ]]; then
    ADB_BIN="$ANDROID_SDK_ROOT/platform-tools/adb"
    EMULATOR_BIN="$ANDROID_SDK_ROOT/emulator/emulator"
    [[ -x "$AVDMANAGER_BIN" ]] || download_cmdline_tools
    return 0
  fi
  install_sdk_packages
  resolve_sdk_tools
  ADB_BIN="$ANDROID_SDK_ROOT/platform-tools/adb"
  EMULATOR_BIN="$ANDROID_SDK_ROOT/emulator/emulator"
  [[ -x "$ADB_BIN" && -x "$EMULATOR_BIN" && -x "$AVDMANAGER_BIN" ]] ||
    die "runtime Android incompleto em $ANDROID_SDK_ROOT"
}

adb_call() {
  "$ADB_BIN" "$@"
}

online_emulators() {
  adb_call devices | awk '$1 ~ /^emulator-/ && $2 == "device" { print $1 }'
}

emulator_avd_name() {
  local serial="$1"
  adb_call -s "$serial" emu avd name 2>/dev/null | sed -n '1p' | tr -d '\r'
}

device_is_online() {
  local serial="$1"
  [[ "$(adb_call -s "$serial" get-state 2>/dev/null || true)" == 'device' ]]
}

create_avd_if_needed() {
  export ANDROID_HOME="$ANDROID_SDK_ROOT"
  export ANDROID_SDK_ROOT ANDROID_SDK_HOME ANDROID_USER_HOME ANDROID_AVD_HOME
  mkdir -p -- "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"
  if ! "$EMULATOR_BIN" -list-avds | grep -Fx -- "$ANDROID_AVD_NAME" >/dev/null 2>&1; then
    local log_file
    log_file="$(runtime_log)"
    printf 'no\n' | "$AVDMANAGER_BIN" create avd --force \
      --name "$ANDROID_AVD_NAME" \
      -k "$SYSTEM_IMAGE" >>"$log_file" 2>&1 ||
      die "avdmanager não criou $ANDROID_AVD_NAME; veja $log_file"
  fi
}

free_emulator_port() {
  require_command ss
  local port
  for port in $(seq 5556 2 5598); do
    if ! ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .; then
      printf '%s\n' "$port"
      return 0
    fi
  done
  die 'não há porta livre para um emulador Android próprio'
}

wait_for_boot() {
  local serial="$1"
  local deadline=$((SECONDS + ANDROID_BOOT_TIMEOUT))
  while (( SECONDS < deadline )); do
    if device_is_online "$serial" && [[ "$(adb_call -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == '1' ]]; then
      adb_call -s "$serial" shell input keyevent 82 >/dev/null 2>&1 || true
      return 0
    fi
    sleep 1
  done
  die "emulador $serial não terminou o boot em ${ANDROID_BOOT_TIMEOUT}s; veja $(runtime_log)"
}

start_owned_emulator() {
  create_avd_if_needed
  EMULATOR_PORT="${EMULATOR_PORT:-$(free_emulator_port)}"
  local serial="emulator-$EMULATOR_PORT"
  local log_file
  log_file="$(runtime_log)"
  local emulator_args=(-avd "$ANDROID_AVD_NAME" -port "$EMULATOR_PORT" -no-boot-anim -no-audio -gpu swiftshader_indirect)
  [[ "$ANDROID_EMULATOR_HEADLESS" == '1' ]] && emulator_args+=(-no-window)
  [[ "$ANDROID_COLD_BOOT" == '1' ]] && emulator_args+=(-no-snapshot-load)
  if [[ "$(uname -s)" == 'Linux' && ! -r /dev/kvm ]]; then
    emulator_args+=(-accel off)
  fi
  log "iniciando AVD próprio $ANDROID_AVD_NAME em $serial" >>"$log_file"
  setsid env ANDROID_HOME="$ANDROID_SDK_ROOT" ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT" \
    ANDROID_SDK_HOME="$ANDROID_SDK_HOME" ANDROID_USER_HOME="$ANDROID_USER_HOME" \
    ANDROID_AVD_HOME="$ANDROID_AVD_HOME" "$EMULATOR_BIN" "${emulator_args[@]}" \
    >>"$log_file" 2>&1 &
  EMULATOR_PID=$!
  EMULATOR_OWNED=1
  adb_call start-server >/dev/null 2>&1 || true
  wait_for_boot "$serial"
  ADB_SERIAL="$serial"
}

choose_device() {
  if [[ -n "$ADB_SERIAL" ]]; then
    device_is_online "$ADB_SERIAL" || die "ADB_SERIAL não está online como device: $ADB_SERIAL"
    EMULATOR_OWNED=0
    return 0
  fi

  if [[ "$REUSE_ANDROID_DEVICE" == '1' ]]; then
    local serial
    serial="$(online_emulators | sed -n '1p')"
    if [[ -n "$serial" ]]; then
      ADB_SERIAL="$serial"
      EMULATOR_OWNED=0
      log "reutilizando emulador online $ADB_SERIAL"
      return 0
    fi
  fi

  start_owned_emulator
}

write_runtime_state() {
  mkdir -p -- "$(dirname -- "$RUNTIME_STATE_FILE")"
  local temporary="$RUNTIME_STATE_FILE.tmp.$$"
  {
    printf 'ANDROID_RUNTIME_CACHE=%q\n' "$ANDROID_RUNTIME_CACHE"
    printf 'ANDROID_SDK_ROOT=%q\n' "$ANDROID_SDK_ROOT"
    printf 'ANDROID_HOME=%q\n' "$ANDROID_SDK_ROOT"
    printf 'ANDROID_SDK_HOME=%q\n' "$ANDROID_SDK_HOME"
    printf 'ANDROID_USER_HOME=%q\n' "$ANDROID_USER_HOME"
    printf 'ANDROID_AVD_HOME=%q\n' "$ANDROID_AVD_HOME"
    printf 'ANDROID_API_LEVEL=%q\n' "$ANDROID_API_LEVEL"
    printf 'ANDROID_ABI=%q\n' "$ANDROID_ABI"
    printf 'ANDROID_AVD_NAME=%q\n' "$ANDROID_AVD_NAME"
    printf 'ADB_BIN=%q\n' "$ADB_BIN"
    printf 'ADB_SERIAL=%q\n' "$ADB_SERIAL"
    printf 'EMULATOR_BIN=%q\n' "$EMULATOR_BIN"
    printf 'AVDMANAGER_BIN=%q\n' "$AVDMANAGER_BIN"
    printf 'SDKMANAGER_BIN=%q\n' "$SDKMANAGER_BIN"
    printf 'EMULATOR_PID=%q\n' "$EMULATOR_PID"
    printf 'EMULATOR_OWNED=%q\n' "$EMULATOR_OWNED"
    printf 'EMULATOR_PORT=%q\n' "$EMULATOR_PORT"
  } >"$temporary"
  mv -- "$temporary" "$RUNTIME_STATE_FILE"
}

ensure_runtime() {
  mkdir -p -- "$RUN_DIR" "$EVIDENCE_DIR"

  ANDROID_SDK_ROOT="$(choose_sdk_root)"
  if resolve_adb && [[ -n "$ADB_SERIAL" ]] && device_is_online "$ADB_SERIAL"; then
    log "reutilizando ADB/device informado: $ADB_SERIAL"
  else
    ensure_sdk
    choose_device
  fi

  [[ -x "$ADB_BIN" ]] || die "adb não está disponível após o bootstrap"
  device_is_online "$ADB_SERIAL" || die "device Android não ficou online: $ADB_SERIAL"
  write_runtime_state
  {
    printf 'sdk=%s\n' "$ANDROID_SDK_ROOT"
    printf 'adb=%s\n' "$ADB_BIN"
    printf 'serial=%s\n' "$ADB_SERIAL"
    printf 'avd=%s\n' "$ANDROID_AVD_NAME"
    printf 'owned_emulator=%s\n' "$EMULATOR_OWNED"
    printf 'cache=%s\n' "$ANDROID_RUNTIME_CACHE"
  } >"$EVIDENCE_DIR/android-runtime.txt"
  log "Android pronto: $ADB_SERIAL (SDK em $ANDROID_SDK_ROOT; cache em $ANDROID_RUNTIME_CACHE)"
}

usage() {
  cat >&2 <<'EOF'
Uso: android-runtime.sh ensure

ensure  localiza/reusa Android ou provisiona SDK + AVD em cache e grava RUNTIME_STATE_FILE
EOF
}

case "${1:-}" in
  ensure) ensure_runtime ;;
  *) usage; exit 2 ;;
esac
