---
name: verify-t3-mobile-pi
description: "Use for an Android end-to-end acceptance pass of T3 Code Mobile with the Pi provider: isolated pairing, scoped model, text and image, generic tools, main-Pi MCP, interruption, and resume. The skill provisions or reuses the Android runtime and cached Metro before driving the app."
---

# Verificar T3 Mobile com Pi

Esta skill conduz uma execução real do APK `com.t3tools.t3code.dev` em um emulador Android, conectado a um backend T3 descartável e ao Pi instalado no host. Ela transforma o runtime Android em parte da execução: primeiro localiza/reutiliza um SDK e um device compatíveis; se eles não existirem, instala os componentes mínimos em cache e inicia um AVD próprio. Ela não usa setters internos nem endpoints de teste para declarar sucesso: o fluxo passa pelo pareamento, picker, composer e thread que uma pessoa usa.

Leia o [mapa de funcionalidades](features/README.md) antes de escolher o fluxo. A execução padrão cobre uma thread nova com texto e imagem; os outros arquivos do mapa cobrem tools, MCP e ciclo de interrupção/retomada.

## Bootstrap e launch

O primeiro passo é sempre o bootstrap: a ausência de `adb`, do SDK ou de um AVD dispara a preparação automática. O helper tenta, nesta ordem:

1. reutilizar o `ADB_SERIAL` informado e já online;
2. reutilizar um SDK compatível e o Metro saudável do mesmo checkout;
3. instalar em cache `platform-tools`, `emulator`, command-line tools e uma system image `google_apis`;
4. criar/iniciar um AVD próprio, capturando o PID para o cleanup.

O cache Android fica fora do checkout, por padrão em `~/.cache/t3-mobile-pi/android` (ou em `XDG_CACHE_HOME`). O cache é deliberado e persistente; bases T3, reverse ADB, imagem enviada e processos do run continuam descartáveis. Em Linux x86_64 o padrão é API 35 + `x86_64`; em Apple Silicon, API 35 + `arm64-v8a`. Ajuste `ANDROID_API_LEVEL`, `ANDROID_ABI`, `ANDROID_AVD_NAME` ou `ANDROID_RUNTIME_CACHE` somente quando a plataforma exigir.

Por segurança, sem `ADB_SERIAL` o helper inicia um AVD próprio mesmo que outro emulador esteja online. Use `REUSE_ANDROID_DEVICE=1` somente quando aquele device pertencer explicitamente à execução atual.

Use o artefato existente, se compatível. O helper procura os outputs locais e o cache de builds antes de construir; se não encontrar um APK, `AUTO_BUILD_APK=1` (padrão) executa `expo run:android --variant development --no-bundler --no-install` contra o device recém-preparado. Forneça `APK_PATH` apenas para escolher um artefato específico. O candidato usado na aceitação foi:

```bash
export APK_PATH='/tmp/vinicius/eas-cli-nodejs/eas-build-run-cache/440f643b-ed3a-4cfb-a052-2dd7e69fb4b4_0dc63813-60a5-4c88-9992-b694d9dbb8bb.apk'
```

Inicie uma instância com diretório de dados e portas próprios. O helper captura os PIDs que ele mesmo criou, provisiona o Android quando necessário, instala `APK_PATH` quando informado, habilita somente `providerInstances.pi`, sem escrever em `~/.t3`:

```bash
HELPER="$PWD/.agents/skills/verify-t3-mobile-pi/helpers/verify-mobile-pi.sh"
REPO_ROOT="$PWD" APK_PATH="$APK_PATH" \
  REUSE_METRO=1 METRO_CLEAR=0 "$HELPER" launch
```

Guarde o `RUN_DIR`, o `STATE_FILE` e o `EVIDENCE_DIR` impressos. O launch também registra `android-runtime.txt` e `android-runtime.env`; o segundo é temporário e some no cleanup. O backend fica no host em `127.0.0.1:<server-port>` e é anunciado ao Android como `http://10.0.2.2:<server-port>`. O Metro usa `tcp:<metro-port>` via reverse ADB.

Se o APK não estiver instalado, faça a instalação antes do `doctor`:

```bash
source '<state-file>'
export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"
adb -s "$ADB_SERIAL" shell pm path com.t3tools.t3code.dev
```

O `launch` só é considerado pronto quando o device Android está online, `/.well-known/t3/environment` e `/status` do Metro respondem, e os três caminhos (`RUN_DIR`, `STATE_FILE`, `EVIDENCE_DIR`) foram impressos. Por padrão ele reaproveita um Metro saudável do mesmo checkout e conserva o cache do bundler; `METRO_CLEAR=1` é reservado para investigar bundle obsoleto. Se o bootstrap ou o launch falhar, o próprio helper encerra o AVD que criou; depois leia `evidence/logs/android-runtime.log`, `evidence/logs/backend.log` ou `evidence/logs/metro.log` antes de tentar novamente.

## Doctor

Sempre valide a instância exata antes de dirigir o celular:

```bash
RUN_DIR='<run-dir>' "$HELPER" doctor
```

O check é somente leitura e precisa confirmar todos os pontos abaixo:

- os PIDs do backend e do Metro continuam vivos e seus `cwd` pertencem a este checkout;
- o endpoint T3 e o status do Metro respondem;
- `settings.json` contém `providerInstances.pi.driver = "pi"` habilitado;
- `pi --version` está disponível;
- `com.t3tools.t3code.dev` está instalado no serial escolhido;
- o reverse ADB aponta para a porta do Metro.

O relatório é salvo em `EVIDENCE_DIR/doctor.txt`. Um processo vivo em outra porta, outro `cwd`, outro base-dir ou outro package é uma falha de identidade, não uma razão para continuar.

## Drive

Carregue o estado do run e emita um token novo para esse cliente. O token é segredo de uso único: passe-o diretamente para o app e nunca o redirecione para logs, screenshots, commits ou arquivos de evidência.

```bash
source '<state-file>'
export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"
T3CODE_PORT="$SERVER_PORT" node apps/server/src/bin.ts auth pairing create \
  --base-dir "$BASE_DIR" \
  --base-url "$MOBILE_ORIGIN" \
  --ttl 15m \
  --label "verify-pi-$ADB_SERIAL"
```

Abra o Dev Client no emulador com o URL exato que o Metro imprimiu. Quando o helper iniciou o Metro, a forma usual é:

```bash
adb -s "$ADB_SERIAL" shell am start -W \
  -a android.intent.action.VIEW \
  -d 't3code-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<metro-port>' \
  com.t3tools.t3code.dev
```

Na primeira abertura de um APK de desenvolvimento, o Expo pode mostrar o menu de desenvolvedor antes da aplicação: toque `Continue` uma vez e use o botão voltar para fechá-lo. Esse estado nativo não é a tela do T3; só prossiga quando a árvore mostrar `New task` ou `Add environment`.

Para parear, use a rota registrada quando o botão semântico não estiver visível:

```bash
adb -s "$ADB_SERIAL" shell am start -W \
  -a android.intent.action.VIEW \
  -d 't3code-dev://connections/new' \
  com.t3tools.t3code.dev
```

No app, preencha o origin `http://10.0.2.2:<server-port>` e o token recém-criado. Confirme que o projeto `T3 Code Pi verification` aparece. Depois dirija a UI por semântica: atualize a árvore com `uiautomator dump`, prefira `content-desc`, `text`, `resource-id` e os `bounds` do nó encontrado; não fixe coordenadas antes de inspecionar a árvore.

Handles reais do mobile observados no fluxo:

- home: `New task`;
- thread nova: `Thread settings`, `Add attachment`, `Start task`;
- thread existente: `Send`;
- ferramentas de thread: `Open files`, `Open terminal`, `Open git controls`;
- durante trabalho: texto `Working for ...` e o controle visual vermelho de interrupção;
- modelo esperado: `GPT-5.6 Sol · Full` para `pi/openai-codex/gpt-5.6-sol`.

Para preparar uma imagem real no picker sem depender da galeria do host:

```bash
RUN_DIR='<run-dir>' "$HELPER" prepare-image "$PWD/apps/mobile/assets/android-icon-mark.png"
```

Na UI, use `New task`, escolha o projeto, abra as configurações de thread e selecione `pi/openai-codex/gpt-5.6-sol` com o nível de thinking usado pela aceitação. Toque `Add attachment`, escolha `t3-wayfinder.png`, escreva uma instrução que peça a palavra `WAYFINDER` e envie por `Start task`. Aguarde o estado terminal e valide, no mesmo thread, o texto do usuário, a miniatura ou indicador de anexo e uma única resposta do assistente.

Para reproduzir as extensões e o lifecycle, siga os arquivos do mapa: solicite uma única chamada `subagent_spawn` seguida de `subagent_wait`, solicite `t3_preview_status` apenas no Pi principal, depois envie um comando bloqueante (`tail -f /dev/null`), interrompa pelo controle do mobile, confirme o estado `interrupted` e envie uma nova mensagem curta que responda `RESUME-OK`.

Depois de cada ação relevante, capture a mesma tela e a árvore semântica:

```bash
RUN_DIR='<run-dir>' "$HELPER" capture 01-pi-thread
```

## Evidence

Uma prova válida registra a ação e o resultado, não somente a tela final. Mantenha todos os artefatos dentro do `EVIDENCE_DIR` do run:

- `android-runtime.txt`, `doctor.txt`, `server-environment.json`, `metro-status.txt` e logs do runtime/backend/Metro para identidade e launch; `metro-reused.txt` prova quando a execução aproveitou o processo/cache existente;
- pares `*.ui.xml` + `*.png` para pareamento, picker, anexo, resposta, interrupção e retomada;
- `db-proof.txt`, gerado depois de a thread terminar:

  ```bash
  RUN_DIR='<run-dir>' "$HELPER" db-proof
  ```

O `db-proof` registra somente contagens, estados, seleção de modelo truncada, summaries de atividades relevantes e nomes de RPC; não despeja corpos de mensagens nem tokens. O resultado funcional precisa mostrar, em conjunto:

- um modelo Pi scoped no thread e o mesmo `thread_id` para a mensagem e a resposta;
- uma mensagem do usuário com um anexo e exatamente uma mensagem do assistente para a primeira rodada;
- `subagent_spawn`/`subagent_wait` como tool calls genéricas, `t3_preview_status` somente no log do Pi principal e ausência de `t3_*` no registro do subagente;
- turno interrompido, novo envio na mesma thread com `RESUME-OK` e nenhum processo Pi órfão depois do settle;
- ausência de `/quota` e `/hud` no fluxo.

O arquivo [.scratch/pi-integration/issues/23-aceitacao-mobile-pi-ponta-a-ponta.md](../../../.scratch/pi-integration/issues/23-aceitacao-mobile-pi-ponta-a-ponta.md) é a referência histórica da aceitação já concluída; ele não substitui a nova captura da execução. O cleanup grava `cleanup.txt`; sem esse arquivo e sem as provas acima, a execução está incompleta.

## Cleanup

Faça o cleanup mesmo quando uma etapa falhar. Ele remove apenas o reverse ADB criado pelo helper, a imagem exata enviada ao device, o AVD iniciado pelo run, os grupos de processos capturados e o `base/` dentro do run. O diretório de evidência permanece:

```bash
RUN_DIR='<run-dir>' "$HELPER" cleanup
test -d '<evidence-dir>'
```

Se o helper foi apontado para um `BASE_DIR` externo, ele preserva esse diretório e informa isso; não use a skill contra `~/.t3`. Não encerre processos por nome ou por `grep`: o helper só atua nos PIDs e grupos POSIX que registrou no `launch`.

Após o cleanup, prove que o artefato sobreviveu e que não há sobra funcional:

```bash
find '<evidence-dir>' -maxdepth 2 -type f -print | sort
"$ADB_BIN" -s "$ADB_SERIAL" reverse --list
ps -eo pid=,ppid=,args= | rg 'pi( |$)|expo start|apps/server/src/bin.ts serve' || true
```

O último comando é somente leitura. Se encontrar um processo criado pela execução, identifique-o pelo PID registrado nos logs e corrija a rotina de encerramento antes de declarar a skill saudável.

## Helpers

O bootstrap do runtime está em [helpers/android-runtime.sh](helpers/android-runtime.sh); o [helper principal](helpers/verify-mobile-pi.sh) chama-o automaticamente no `launch`. O bootstrap é idempotente e recebe o cache fora do checkout; a ausência inicial de `adb` vira uma etapa executável do run. Todas as ações abaixo estão implementadas e recebem o `RUN_DIR` do launch:

```bash
RUN_DIR='<run-dir>' "$HELPER" doctor
RUN_DIR='<run-dir>' "$HELPER" capture <label>
RUN_DIR='<run-dir>' "$HELPER" prepare-image [arquivo.png]
RUN_DIR='<run-dir>' "$HELPER" db-proof
RUN_DIR='<run-dir>' "$HELPER" env
RUN_DIR='<run-dir>' "$HELPER" cleanup
```

Critério de conclusão da execução: `android-runtime.txt`, `doctor.txt`, `server-environment.json`, `metro-status.txt`, os pares de captura exigidos, `db-proof.txt` e `cleanup.txt` existem no `EVIDENCE_DIR`; o run não é chamado de validado quando qualquer uma dessas provas falta.

Ao alterar o fluxo mobile, atualize também o mapa e rode `/maintain-verification-skill` para procurar entry points, handles ou estados reversos que tenham ficado obsoletos.
