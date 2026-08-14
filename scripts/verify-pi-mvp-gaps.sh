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

TOTAL_STAGES=9
CHECKS=()
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_BASE_DIR=""
MOBILE_HELPER="$REPO_ROOT/.agents/skills/verify-t3-mobile-pi/helpers/verify-mobile-pi.sh"
MOBILE_SERIAL=""
MOBILE_RUN_DIR=""
MOBILE_STATE_FILE=""
MOBILE_EVIDENCE_DIR=""
MOBILE_SERVER_PORT=""
MOBILE_ORIGIN=""
MEMORY_NOTES=""
FINAL_NOTES=""
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

# These helpers live below the library marker so the template remains intact.
code() { printf '  %s$%s %s\n' "$GREEN" "$RESET" "$1"; }
prompt_line() { printf '  %s>%s %s\n' "$BLUE" "$RESET" "$1"; }
expected() { printf '  %s✓ esperado:%s %s\n' "$GREEN" "$RESET" "$1"; }

show_web_pair_command() {
  if [[ -n "$WEB_BASE_DIR" ]]; then
    code "node apps/server/src/bin.ts pair --base-dir '$WEB_BASE_DIR' --ttl 15m --label pi-mvp-web"
  else
    code "node apps/server/src/bin.ts pair --base-dir '<BASE_DIR_DA_SAIDA_DEV-RUNNER>' --ttl 15m --label pi-mvp-web"
  fi
}

show_web_project_command() {
  if [[ -n "$WEB_BASE_DIR" ]]; then
    code "node apps/server/src/bin.ts project add '$REPO_ROOT' --base-dir '$WEB_BASE_DIR' --title 'T3 Code Pi verification'"
  else
    code "node apps/server/src/bin.ts project add '$REPO_ROOT' --base-dir '<BASE_DIR_DA_SAIDA_DEV-RUNNER>' --title 'T3 Code Pi verification'"
  fi
}

show_pi_settings_command() {
  code 'mkdir -p "$WEB_BASE_DIR/userdata"'
  code "PI_SETTINGS_PATH=\"\$WEB_BASE_DIR/userdata/settings.json\" node -e 'const fs=require(\"node:fs\"); const p=process.env.PI_SETTINGS_PATH; fs.writeFileSync(p, JSON.stringify({providerInstances:{pi:{driver:\"pi\",enabled:true,config:{}}}}, null, 2)+\"\\n\")'"
}

finish_validation() {
  _clear
  ask FINAL_NOTES "Observações finais sem tokens (opcional):"
  {
    printf '# T3 + Pi MVP validation\n\n'
    printf -- '- generated: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf -- '- web base-dir: %s\n' "${WEB_BASE_DIR:-not captured}"
    printf -- '- mobile origin: %s\n' "${MOBILE_ORIGIN:-not captured}"
    printf -- '- mobile run dir: %s\n' "${MOBILE_RUN_DIR:-not captured}"
    printf -- '- mobile evidence dir: %s\n' "${MOBILE_EVIDENCE_DIR:-not captured}"
    printf '\n## Checks\n\n'
    for check in "${CHECKS[@]}"; do
      IFS='|' read -r status label <<< "$check"
      printf -- '- %s: %s\n' "$status" "$label"
    done
    printf '\n## Metrics and notes\n\n%s\n%s\n' "${MEMORY_NOTES:-No memory notes recorded.}" "$FINAL_NOTES"
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
say "Execute as etapas na ordem. O wizard mostra comandos copiáveis e o resultado que você deve observar."
say "Ele não inicia servidores, não altera ~/.t3/userdata e não salva tokens."
say "Mantenha este wizard em um terminal próprio. Quando ele disser Terminal A, B, C ou D, use terminais separados para os comandos."
note "Comece no checkout do projeto: $REPO_ROOT"
note "Os comandos Android abaixo usam o helper versionado em $MOBILE_HELPER; ele prepara settings, projeto, APK, Metro, backend, PIDs e cleanup."
note "Pairing URLs e tokens são segredos de uso único. Nunca os cole neste wizard, em screenshots ou em logs."

stage "Preparar o web remoto"
say "Este caminho usa um base-dir web descartável, habilita o Pi nele e publica o web por Tailscale Serve."
step "Abra o Terminal A e mantenha-o aberto durante a validação."
code "cd '$REPO_ROOT'"
code 'WEB_BASE_DIR=$(mktemp -d /tmp/t3-pi-mvp-web.XXXXXX)'
code 'printf "WEB_BASE_DIR=%s\\n" "$WEB_BASE_DIR"'
show_pi_settings_command
code "node apps/server/src/bin.ts project add '$REPO_ROOT' --base-dir \"\$WEB_BASE_DIR\" --title 'T3 Code Pi verification'"
code 'tailscale status'
code 'tailscale ip -4'
step "Confirme que o segundo dispositivo está conectado à mesma tailnet antes de continuar."
code 'pnpm exec vp run dev --share --home-dir "$WEB_BASE_DIR"'
note "Se vp já estiver no PATH, vp run dev --share --home-dir \"$WEB_BASE_DIR\" é equivalente. O dev runner não abre o navegador automaticamente."
step "Espere a linha [dev-runner] e a linha shared on tailnet. O runner também imprime um pairingUrl inicial."
expected "o processo permanece rodando e a saída mostra serverPort, webPort, baseDir e um endereço HTTPS compartilhado."
step "Anote o WEB_BASE_DIR impresso. O pairingUrl inicial é secreto e pode ser deixado sem uso; vamos emitir um token fresco depois de testar alcance."
ask WEB_BASE_DIR "Cole o WEB_BASE_DIR impresso no Terminal A (não inclua aspas; não é um token):"
step "No segundo dispositivo, abra apenas a origem HTTPS do endereço compartilhado, sem /pair e sem #token. Isso testa alcance sem gastar um token."
expected "a origem responde com T3 Code pedindo autenticação ou mostra a tela inicial, mas nenhum token foi consumido."
step "Se o pairingUrl foi consumido ou expirou, gere um token novo no Terminal B, apontando para este base-dir:"
code "cd '$REPO_ROOT'"
show_web_pair_command
expected "um novo Pairing URL: é impresso; use-o somente no outro dispositivo."
pause "Deixe o Terminal A rodando e pressione Enter quando você tiver o pairing URL completo."

stage "Validar o web remoto"
say "Agora você vai usar o web client em um segundo navegador ou computador. O link é o pairingUrl copiado na etapa anterior."
step "No segundo dispositivo, abra o pairingUrl completo uma única vez. Se o navegador perguntar, permita o carregamento do site. Não abra o mesmo URL no host."
expected "o navegador sai da rota /pair e mostra T3 Code autenticado."
step "Abra New task, escolha o projeto. Se a lista estiver vazia, volte ao Terminal B e rode este comando com o base-dir anotado:"
code "cd '$REPO_ROOT'"
show_web_project_command
step "Depois de adicionar o projeto, volte ao segundo dispositivo, feche e reabra New task para atualizar a lista."
step "No projeto, abra Thread settings/model picker e selecione Pi → pi/openai-codex/gpt-5.6-sol. Confirme a apresentação GPT-5.6 Sol · Full."
step "Envie exatamente WEB-REMOTE-OK e aguarde o turno terminar."
expected "a mensagem aparece na thread e a resposta do Pi chega sem erro, não em uma thread nova."
step "Anexe um PNG ou JPEG pequeno no botão Add attachment. Use um arquivo que exista no segundo dispositivo, ou copie antes o arquivo $REPO_ROOT/apps/mobile/assets/android-icon-mark.png para ele."
prompt_line "Responda exatamente WEB-IMAGE-OK e diga em uma frase o que você vê na imagem."
step "Envie a mensagem e espere desaparecer o estado de trabalho."
expected "a miniatura fica no composer/mensagem enviada e a resposta contém WEB-IMAGE-OK."
step "Se estiver usando app.t3.codes, só use um pairing URL HTTPS. A página hospedada não pode conectar a um backend http://192.168.x.y."
record_check "Web remoto com texto e imagem" "O segundo dispositivo pareou, selecionou o Pi e completou texto e imagem?"

stage "Preparar o Android por LAN ou Tailscale"
say "O helper existente prepara settings com Pi habilitado, projeto, APK/dev client, Metro, backend, estado e cleanup. Use-o para não montar um base-dir incompleto."
step "No Terminal C, confirme que o aparelho está conectado e autorizado:"
code 'adb devices'
ask MOBILE_SERIAL "Cole o serial do aparelho que aparece como device:"
ask MOBILE_SERVER_PORT "Escolha a porta do backend (14273 se estiver livre):"
step "Escolha o origin que o aparelho alcança. Para LAN Linux:"
code "LAN_IP=\$(ip route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if (\$i == \"src\") {print \$(i+1); exit}}')"
code "printf 'http://%s:$MOBILE_SERVER_PORT\\n' \"\$LAN_IP\""
step "Para Tailscale, confirme a mesma tailnet nos dois dispositivos e use:"
code 'tailscale status'
code 'TAILSCALE_IP=$(tailscale ip -4)'
code "printf 'http://%s:$MOBILE_SERVER_PORT\\n' \"\$TAILSCALE_IP\""
ask MOBILE_ORIGIN "Cole o origin completo escolhido, por exemplo http://192.168.1.42:14273:"
step "No Terminal C, rode o launch em uma única linha. Se a porta estiver ocupada, escolha outra e mantenha-a igual no origin:"
code "cd '$REPO_ROOT'"
code "ADB_SERIAL='$MOBILE_SERIAL' REUSE_ANDROID_DEVICE=1 SERVER_BIND_HOST=0.0.0.0 SERVER_PORT='$MOBILE_SERVER_PORT' MOBILE_ORIGIN='$MOBILE_ORIGIN' REPO_ROOT='$REPO_ROOT' RUN_PARENT=/tmp/t3-pi-mvp-mobile '$MOBILE_HELPER' launch"
step "O helper pode reutilizar o dev client ou construir um APK. Não interrompa até imprimir RUN_DIR, STATE_FILE e EVIDENCE_DIR."
ask MOBILE_RUN_DIR "Cole o RUN_DIR impresso pelo helper:"
ask MOBILE_STATE_FILE "Cole o STATE_FILE impresso pelo helper:"
ask MOBILE_EVIDENCE_DIR "Cole o EVIDENCE_DIR impresso pelo helper:"
step "Valide a identidade exata antes de abrir o app:"
code "RUN_DIR='$MOBILE_RUN_DIR' '$MOBILE_HELPER' doctor"
expected "doctor passa backend/Metro do checkout, settings providerInstances.pi habilitado, pi --version, APK correto, endpoint e reverse ADB."
step "Emita um token para o origin exato, sem salvar o token:"
code "source '$MOBILE_STATE_FILE' && T3CODE_PORT=\"\$SERVER_PORT\" node '$REPO_ROOT/apps/server/src/bin.ts' auth pairing create --base-dir \"\$BASE_DIR\" --base-url \"\$MOBILE_ORIGIN\" --ttl 15m --label pi-mvp-android"
expected "Token: ... é impresso. Copie somente o token para o app; não o envie ao wizard."
note "0.0.0.0 serve apenas no parâmetro SERVER_BIND_HOST. Nunca coloque 0.0.0.0 no campo Host do app."
pause "Pressione Enter depois que doctor passou e você tiver o token novo na tela do Terminal C."

stage "Validar Android por LAN ou Tailscale"
say "Use o dev client que o helper validou. O host é o origin real, não o endereço de bind."
step "Abra o T3 Code Dev. Se Add Environment não aparecer, abra esta rota:"
code "adb -s '$MOBILE_SERIAL' shell am start -W -a android.intent.action.VIEW -d 't3code-dev://connections/new' com.t3tools.t3code.dev"
step "Se o app ainda estiver no menu de desenvolvimento, toque Continue e feche o menu uma vez."
step "Se o helper já imprimiu o Metro, abra o URL exato do dev client. O reverse ADB permite que 127.0.0.1:METRO_PORT no app alcance o Metro do host:"
code "source '$MOBILE_STATE_FILE' && export PATH=\"\$ANDROID_SDK_ROOT/platform-tools:\$ANDROID_SDK_ROOT/emulator:\$PATH\" && adb -s \"\$ADB_SERIAL\" shell am start -W -a android.intent.action.VIEW -d \"t3code-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A\$METRO_PORT\" com.t3tools.t3code.dev"
expected "o dev client mostra New task ou Add Environment, e o bundle pertence a este checkout."
step "No formulário Add Environment, preencha Host com $MOBILE_ORIGIN e Pairing code com o token emitido no Terminal C."
step "Não use http://localhost, http://127.0.0.1, http://0.0.0.0 ou 10.0.2.2 neste teste de rede real. 10.0.2.2 é somente para Android Emulator falando com o host local."
step "Se a conexão falhar, abra primeiro no navegador do aparelho:"
prompt_line "$MOBILE_ORIGIN/.well-known/t3/environment"
expected "o endpoint T3 responde. Se não abrir, corrija IP, rota ou firewall antes de investigar o Pi."
step "Depois do pairing, confirme o projeto T3 Code Pi verification, abra New task, abra Thread settings e selecione Pi → pi/openai-codex/gpt-5.6-sol / GPT-5.6 Sol · Full."
step "Envie exatamente ANDROID-NETWORK-OK e aguarde o estado terminal."
expected "a resposta aparece na mesma thread e não fica em Working for ... indefinidamente."
step "Anexe a mesma imagem pequena usada no teste web pelo Add attachment e envie:"
prompt_line "Responda exatamente ANDROID-IMAGE-OK e diga em uma frase o que você vê na imagem."
expected "a imagem aparece no composer/mensagem enviada e a resposta contém ANDROID-IMAGE-OK."
step "Se o host usa UFW e o aparelho não chega à porta, libere temporariamente a porta e remova-a ao terminar:"
code "sudo ufw allow '$MOBILE_SERVER_PORT'/tcp"
code "sudo ufw delete allow '$MOBILE_SERVER_PORT'/tcp"
record_check "Android por rede real com texto e imagem" "O Android completou texto e imagem usando LAN ou Tailscale, sem 10.0.2.2?"

stage "Reconectar depois de reiniciar"
say "Use a mesma thread web validada. O teste reinicia o processo que atende o web remoto, não o Android."
step "Na thread web do segundo dispositivo, envie RESTART-BEFORE e espere a resposta final."
step "No Terminal A, encerre somente o dev runner com Ctrl-C. Não use pkill, killall ou um padrão de nome."
step "No Terminal A, inicie-o de novo com o mesmo base-dir:"
code "cd '$REPO_ROOT'"
code "pnpm exec vp run dev --share --home-dir '$WEB_BASE_DIR'"
step "Não faça pairing de novo. Volte ao mesmo ambiente salvo no segundo navegador e espere a reconexão."
step "Na mesma thread, envie exatamente RECONNECT-OK."
expected "a thread existente sincroniza, a mensagem nova termina e não há mensagem duplicada, thread nova ou spinner permanente. Se o cliente exigir novo pairing, marque falha de recuperação."
record_check "Reconexão e retomada do web" "A thread web existente voltou depois do restart sem duplicação ou estado preso?"

stage "Testar subagentes com o contrato real"
say "O teste anterior cobriu spawn + wait. Agora vamos exercitar list, check, cancel e wait com IDs reais."
step "Na thread principal Pi, cole a instrução abaixo. Ela pede chamadas de ferramenta; não aceite uma resposta que apenas descreva o que faria."
prompt_line 'Use as ferramentas de subagentes, não apenas explique. Faça exatamente nesta ordem:'
prompt_line '1. subagent_spawn com name "cancel-me", harness "pi" e prompt "Execute bash -lc '\''tail -f /dev/null'\'' e permaneça bloqueado."'
prompt_line '2. subagent_spawn com name "finishes", harness "pi" e prompt "Responda exatamente SUBAGENT-B-OK e termine."'
prompt_line '3. Use subagent_list e registre os dois IDs e os status.'
prompt_line '4. Use subagent_check no ID cancel-me enquanto ele estiver running.'
prompt_line '5. Use subagent_cancel com o ID cancel-me.'
prompt_line '6. Use subagent_wait com o ID finishes e mostre o resultado final.'
step "Se o Pi precisar do nome técnico, os parâmetros aceitos são prompt, name, harness, working_dir, model e reasoning_effort. Os IDs retornados têm formato sa-N."
expected "cancel-me passa a cancelado, finishes termina com SUBAGENT-B-OK, e list/check mostram o estado correto."
step "Confira a UI: os resultados ficam na thread principal, não nasce uma thread T3 filha e nenhum processo tail continua após o cancelamento."
step "Repita apenas para os harnesses que a própria ferramenta listar como disponíveis. Para um harness incompatível, registre o erro explícito em vez de trocar silenciosamente o teste."
record_check "Controle completo de subagentes" "List, check, cancel e wait funcionaram com os IDs reais e sem processo preso?"

stage "Medir imagem repetida e memória"
say "O run anterior teve uma imagem lenta e abriu ferramentas inesperadas. Este teste separa lentidão de crescimento persistente."
step "Carregue o estado do helper e veja primeiro somente os processos deste run:"
code "source '$MOBILE_STATE_FILE'"
code 'ps -o pid=,ppid=,rss=,vsz=,etime=,args= -p "$BACKEND_PID"'
code 'pstree -ap "$BACKEND_PID" 2>/dev/null || ps -o pid=,ppid=,rss=,vsz=,etime=,args= --ppid "$BACKEND_PID"'
step "Anote o PID do processo Pi filho exibido pela árvore. Se não aparecer, aguarde um turno curto e repita a leitura; não procure nem mate processos por nome."
ask MEMORY_PI_PID "Cole o PID exato do processo Pi deste run:"
step "No Terminal C, mantenha o monitor abaixo rodando durante os turnos Android. Ele acompanha somente o backend e o Pi do mesmo run:"
code "MEMORY_PI_PID='$MEMORY_PI_PID'"
code 'while sleep 2; do date; ps -o pid=,ppid=,rss=,vsz=,etime=,args= -p "$BACKEND_PID,$MEMORY_PI_PID"; done'
note "Interrompa esse monitor com Ctrl-C. O comando é somente leitura."
step "Com o monitor ativo no Terminal C, abra a thread Android validada na etapa anterior e envie a mesma imagem pequena em três turnos separados. No app Android, use estes prompts, um por vez:"
prompt_line 'Responda exatamente IMAGE-1-OK e não use ferramentas.'
prompt_line 'Responda exatamente IMAGE-2-OK e não use ferramentas.'
prompt_line 'Responda exatamente IMAGE-3-OK e não use ferramentas.'
step "Para cada turno, anote hora de início/fim, maior RSS, resposta recebida e se alguma ferramenta foi chamada apesar do prompt."
expected "os três turnos chegam ao estado terminal; após alguns segundos o RSS dos dois PIDs estabiliza, sem crescimento monotônico nem processo novo órfão."
step "Se o Pi usar read/bash sem o prompt pedir isso, ou se o tempo/RSS crescer a cada imagem, marque falha de contexto/performance e guarde logs sem tokens."
ask MEMORY_NOTES "Cole um resumo sem tokens: tempos, maior RSS e tendência observada:"
record_check "Imagem repetida sem crescimento persistente" "Os três turnos terminaram sem crescimento persistente de memória, contexto inesperado ou processo órfão?"

stage "Validar token expirado e recuperar pairing"
say "Este teste confirma que um token vencido falha claramente e que um token novo recupera o acesso."
step "Em Terminal D, crie um token curto para o mesmo origin. Não o cole neste wizard:"
code "source '$MOBILE_STATE_FILE' && T3CODE_PORT=\"\$SERVER_PORT\" node '$REPO_ROOT/apps/server/src/bin.ts' auth pairing create --base-dir \"\$BASE_DIR\" --base-url \"\$MOBILE_ORIGIN\" --ttl 30s --label pi-mvp-expiring"
step "Use outro aparelho ou remova temporariamente o ambiente do cliente Android de teste para abrir Add Environment de novo. Não use a thread já pareada para este caso."
step "Copie o token somente para esse segundo pairing e espere 35 segundos:"
code 'sleep 35'
step "Em Add Environment, preencha Host com o mesmo origin e Pairing code com o token expirado. Não tente o mesmo token repetidamente."
expected "o cliente mostra erro de token expirado/rejeitado e não salva um ambiente parcialmente conectado."
step "Emita um token novo, usando o mesmo comando com --ttl 15m e outro --label. Pareie com ele e confirme que o host responde."
code "source '$MOBILE_STATE_FILE' && T3CODE_PORT=\"\$SERVER_PORT\" node '$REPO_ROOT/apps/server/src/bin.ts' auth pairing create --base-dir \"\$BASE_DIR\" --base-url \"\$MOBILE_ORIGIN\" --ttl 15m --label pi-mvp-recovery"
step "Abra uma thread nova no cliente recuperado e envie TOKEN-RECOVERY-OK."
expected "o token novo pareia e o turno termina normalmente."
record_check "Recuperação após token expirado" "O token vencido falhou claramente e um token novo recuperou o pairing?"

stage "Fazer cleanup e confirmar ausência de órfãos"
say "Use o cleanup do helper para encerrar somente os PIDs, reverse ADB, imagem e base que ele registrou."
step "No Terminal A, encerre vp run dev --share com Ctrl-C. O runner remove a publicação temporária do Tailscale ao sair."
step "No Terminal C, rode o cleanup do run Android:"
code "RUN_DIR='$MOBILE_RUN_DIR' '$MOBILE_HELPER' cleanup"
expected "cleanup.txt é salvo, a pasta de evidências continua, e o helper remove backend, Metro, reverse ADB, imagem e base temporária do run."
step "Confira a evidência e o reverse ADB:"
code "find '$MOBILE_EVIDENCE_DIR' -maxdepth 2 -type f -print | sort"
code "adb -s '$MOBILE_SERIAL' reverse --list"
step "Confira a porta exata do backend e processos somente por leitura:"
code "ss -H -ltnp | rg ':$MOBILE_SERVER_PORT\\b' || true"
code 'ps -eo pid=,ppid=,args= | rg "apps/server/src/bin.ts serve|pi( |$)" || true'
step "Se aparecer algo, registre PID, PPID, cwd e comando. Só encerre um PID depois de confirmar no estado/log que ele pertence a este run."
WEB_BASE_DIR_RESOLVED=""
if [[ -n "$WEB_BASE_DIR" ]]; then
  WEB_BASE_DIR_RESOLVED="$(realpath -- "$WEB_BASE_DIR" 2>/dev/null || true)"
fi
if [[ "$WEB_BASE_DIR_RESOLVED" == /tmp/t3-pi-mvp-web.* ]] && [[ "$(dirname -- "$WEB_BASE_DIR_RESOLVED")" == /tmp ]] && [[ "$WEB_BASE_DIR_RESOLVED" != /tmp ]]; then
  if confirm "Apagar o base-dir web descartável '$WEB_BASE_DIR_RESOLVED'?"; then
    code "WEB_BASE_DIR='$WEB_BASE_DIR_RESOLVED'"
    code 'resolved=$(realpath -- "$WEB_BASE_DIR")'
    code 'if [[ "$resolved" == /tmp/t3-pi-mvp-web.* ]] && [[ "$(dirname -- "$resolved")" == /tmp ]] && [[ "$resolved" != /tmp ]]; then rm -rf -- "$resolved"; else echo "caminho recusado" >&2; exit 1; fi'
    note "O guard resolve o caminho e só aceita um diretório direto em /tmp com o prefixo t3-pi-mvp-web.; confira antes de executar."
  fi
else
  note "O base-dir web foi preservado. Remova-o depois somente se o caminho continuar sendo /tmp/t3-pi-mvp-web.*."
fi
record_check "Cleanup sem sobra funcional" "Os processos e portas desta execução terminaram, e nenhum reverse/base descartável ficou ativo?"

finish_validation
