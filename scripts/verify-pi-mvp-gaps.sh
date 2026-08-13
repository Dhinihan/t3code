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

TOTAL_STAGES=7
CHECKS=()

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

finish_validation() {
  _clear
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
  printf '\n'
}

banner "Validação dos gaps do MVP T3 + Pi"
say "Este wizard cobre ações que exigem seu dispositivo, sua rede ou sua observação do processo."
say "Ele não inicia servidores, não altera ~/.t3/userdata e não salva tokens."
note "Pré-requisito: use uma execução T3 isolada e tenha à mão o cliente web ou o APK que você quer validar."

stage "Web em outro cliente ou rede"
say "Prove que o web client funciona quando não usa localhost do host."
step "Abra o web client em outro navegador, computador ou rede alcançável pelo host."
step "Use a URL completa de pareamento com token. Em outro dispositivo, não use 0.0.0.0, localhost ou 127.0.0.1."
step "Confirme o projeto, selecione o modelo Pi e envie uma mensagem com o texto WEB-REMOTE-OK."
step "Envie também uma imagem pequena e confirme que a resposta chega sem perder o texto ou o anexo."
record_check "Web remoto com texto e imagem" "O web client remoto pareou e completou texto e imagem?"

stage "Android por LAN ou Tailscale"
say "Troque o emulador com 10.0.2.2 por um caminho que represente o aparelho real."
step "Use um aparelho Android físico ou um emulador que alcance o host pela rede."
step "No campo Host do app, informe http://IP-OU-NOME-DO-HOST:PORTA ou o endereço Tailscale. Use a porta real do backend."
step "Gere um token de pareamento novo, pareie, selecione o Pi e envie ANDROID-NETWORK-OK."
step "Repita com uma imagem pequena. Verifique que o app mostra o resultado na mesma thread e não abre uma thread filha."
record_check "Android por rede real" "O Android completou texto e imagem por LAN ou Tailscale?"

stage "Reconectar depois de reiniciar"
say "Prove que uma thread existente continua recuperável depois de uma queda normal do cliente ou do host."
step "Na mesma thread, envie RESTART-BEFORE e espere o turno terminar."
step "Feche o navegador ou force o fechamento do app. Pare e reinicie somente o backend da execução isolada, usando o terminal ou o PID que você capturou."
step "Abra o cliente novamente, volte à thread existente e espere a sincronização terminar."
step "Envie RECONNECT-OK. Confirme que não apareceu uma mensagem duplicada, um spinner permanente ou uma thread nova inesperada."
record_check "Reconexão e retomada da thread" "A thread retomou depois do reinício sem duplicação ou estado preso?"

stage "Subagentes: list, check, cancel e wait"
say "O run anterior cobriu spawn + wait. Agora falta provar o controle completo da extensão."
step "Na thread Pi principal, peça duas chamadas subagent_spawn em paralelo."
step "No filho A, peça uma tarefa bloqueante como tail -f /dev/null. No filho B, peça que responda SUBAGENT-B-OK e termine."
step "Peça ao Pi principal para usar subagent_list e subagent_check, cancelar A com subagent_cancel e aguardar B com subagent_wait."
step "Confirme na UI que o filho cancelado encerrou, B terminou, os resultados ficaram na thread principal e nenhuma thread T3 filha foi criada."
step "Repita para cada harness que a própria extensão listar e que você realmente usa. Não invente combinações ausentes no catálogo."
record_check "Controle completo de subagentes" "List, check, cancel e wait funcionaram sem thread filha nem processo preso?"

stage "Imagem repetida e memória"
say "O run anterior encontrou uma resposta de imagem lenta. Meça se o processo volta ao nível normal antes de fechar o MVP."
step "No terminal, anote os PIDs do backend e do Pi desta execução. Monitore-os com ps -o pid=,ppid=,rss=,vsz=,etime=,args= -p PID durante três turnos de imagem."
step "No web client, envie três imagens pequenas em turnos separados. Anote tempo até a resposta, pico de RSS e se o Pi abriu ferramentas inesperadas."
step "Depois que cada turno terminar, espere alguns segundos e confirme que a memória não cresce sem voltar a um patamar estável."
step "Faça o cleanup da execução e confirme que os PIDs capturados morreram. Não use pgrep ou pkill para decidir o alvo."
record_check "Imagem repetida sem crescimento persistente" "Os três turnos de imagem terminaram sem crescimento persistente de memória ou processo órfão?"

stage "Token expirado e novo pareamento"
say "Prove a recuperação de autenticação sem reciclar um token inválido."
step "No ambiente descartável, crie um token de pareamento com TTL curto, por exemplo 30 segundos, usando o comando de pairing da skill verify-t3-mobile-pi."
step "Espere a expiração e tente parear com o token vencido. O cliente deve mostrar uma falha clara, sem criar um ambiente parcialmente conectado."
step "Gere um segundo token, pareie de novo e confirme que o mesmo host e a mesma thread continuam utilizáveis."
step "Não coloque nenhum token em screenshot, log, commit ou arquivo de evidência."
record_check "Recuperação após token expirado" "O token vencido falhou de forma clara e um token novo recuperou o pareamento?"

stage "Cleanup e prova de ausência de órfãos"
say "Feche o run como um usuário faria e preserve somente as evidências necessárias."
step "Se usou o helper mobile, rode RUN_DIR='<run-dir>' .agents/skills/verify-t3-mobile-pi/helpers/verify-mobile-pi.sh cleanup."
step "Confirme que a pasta de evidências continua presente, enquanto base/, AVD criado pelo run, reverse ADB e processos capturados foram removidos."
step "Confira os PIDs e portas exatos da execução. Leia os logs antes de investigar qualquer processo que não pertença a ela."
step "Se algo sobrou, registre o PID, o cwd e o comando. Não mate processos por nome."
record_check "Cleanup sem sobra funcional" "O cleanup deixou evidência útil e nenhum processo, reverse ou base do run?"

finish_validation
