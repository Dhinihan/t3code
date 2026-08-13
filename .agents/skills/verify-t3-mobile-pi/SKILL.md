---
name: verify-t3-mobile-pi
description: "Use when driving one requested T3 Code Mobile Android scenario with the Pi provider: bootstrap/reuse the runtime, pair, select a model, exercise text/image, inspect tools/MCP, or interrupt/resume. Load only the requested recipe; the skill also provides evidence and cleanup."
---

# Verificar T3 Mobile com Pi

Esta skill é um playbook para dirigir um cenário Android escolhido pelo agente, usando o APK `com.t3tools.t3code.dev`, um backend T3 descartável e o Pi instalado no host. O agente escolhe uma receita conforme a solicitação; as demais ficam fora da execução. O runtime Android faz parte do playbook: primeiro localiza/reutiliza um SDK e um device compatíveis; se eles não existirem, instala os componentes mínimos em cache e inicia um AVD próprio. A interação passa pelo pareamento, picker, composer e thread que uma pessoa usa.

Consulte o [mapa de receitas](features/README.md) somente para localizar o procedimento pedido. Não execute as outras receitas por padrão.

## Bootstrap e launch

O primeiro passo é sempre o bootstrap: a ausência de `adb`, do SDK ou de um AVD dispara a preparação automática. O helper tenta, nesta ordem:

1. reutilizar o `ADB_SERIAL` informado e já online;
2. reutilizar um SDK compatível e o Metro saudável do mesmo checkout;
3. instalar em cache `platform-tools`, `emulator`, command-line tools e uma system image `google_apis`;
4. criar/iniciar um AVD próprio, capturando o PID para o cleanup.

O cache Android fica fora do checkout, por padrão em `~/.cache/t3-mobile-pi/android` (ou em `XDG_CACHE_HOME`). O cache é deliberado e persistente; bases T3, reverse ADB, imagem enviada e processos do run continuam descartáveis. Em Linux x86_64 o padrão é API 35 + `x86_64`; em Apple Silicon, API 35 + `arm64-v8a`. Ajuste `ANDROID_API_LEVEL`, `ANDROID_ABI`, `ANDROID_AVD_NAME` ou `ANDROID_RUNTIME_CACHE` somente quando a plataforma exigir.

Por segurança, sem `ADB_SERIAL` o helper inicia um AVD próprio mesmo que outro emulador esteja online. Use `REUSE_ANDROID_DEVICE=1` somente quando aquele device pertencer explicitamente à execução atual.

Use o artefato existente, se compatível. O helper procura os outputs locais e o cache de builds antes de construir; se não encontrar um APK, `AUTO_BUILD_APK=1` (padrão) executa `expo run:android --variant development --no-bundler --no-install` contra o device recém-preparado. Forneça `APK_PATH` apenas para escolher um artefato específico. Um artefato usado anteriormente, se ainda estiver disponível, pode ser selecionado assim:

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

Handles úteis para dirigir o mobile:

- home: `New task`;
- thread nova: `Thread settings`, `Add attachment`, `Start task`;
- thread existente: `Send`;
- ferramentas de thread: `Open files`, `Open terminal`, `Open git controls`;
- durante trabalho: texto `Working for ...` e o controle visual vermelho de interrupção;

Para preparar uma imagem real no picker sem depender da galeria do host:

```bash
RUN_DIR='<run-dir>' "$HELPER" prepare-image "$PWD/apps/mobile/assets/android-icon-mark.png"
```

Para a receita de texto e imagem, use `New task`, escolha o projeto, abra as configurações de thread e selecione o modelo Pi desejado. Toque `Add attachment`, escolha `t3-wayfinder.png`, escreva a instrução solicitada e envie por `Start task`. Aguarde o estado terminal; registre somente as evidências relevantes ao cenário escolhido.

Para a receita de tools/MCP, solicite as chamadas descritas no arquivo correspondente e observe o processo Pi principal e o subagente. Para a receita de lifecycle, envie um comando bloqueante (`tail -f /dev/null`), interrompa pelo controle do mobile e continue a thread conforme a solicitação.

Quando o cenário precisar de evidência visual, capture a tela e a árvore semântica depois da ação relevante:

```bash
RUN_DIR='<run-dir>' "$HELPER" capture 01-pi-thread
```

## Evidence

Registre apenas a ação e o resultado do cenário escolhido, não uma suíte completa. Mantenha os artefatos usados dentro do `EVIDENCE_DIR` do run:

- `android-runtime.txt`, `doctor.txt`, `server-environment.json`, `metro-status.txt` e logs do runtime/backend/Metro para identidade e launch; `metro-reused.txt` prova quando a execução aproveitou o processo/cache existente;
- pares `*.ui.xml` + `*.png` para as telas que o cenário escolhido precisar;
- `db-proof.txt` quando o cenário exigir confirmação do estado persistido:

  ```bash
  RUN_DIR='<run-dir>' "$HELPER" db-proof
  ```

O `db-proof` registra somente contagens, estados, seleção de modelo truncada, summaries de atividades relevantes e nomes de RPC; não despeja corpos de mensagens nem tokens. O cleanup grava `cleanup.txt`.

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

Critério de conclusão: o procedimento solicitado foi executado até seu estado terminal, as evidências escolhidas para esse procedimento foram salvas e `cleanup.txt` confirma a limpeza. Não declare resultados para receitas que não foram executadas.

Ao alterar o fluxo mobile, atualize também o mapa e rode `/maintain-verification-skill` para procurar entry points, handles ou estados reversos que tenham ficado obsoletos.
