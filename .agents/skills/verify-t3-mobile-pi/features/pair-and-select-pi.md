# Receita: parear e selecionar o Pi

Use esta receita quando a tarefa pedir o caminho de conexões, o picker de projeto ou a seleção de um modelo Pi.

## How to get to it (user POV)

- Abrir `Add Environment` pelo fluxo de conexões.
- Usar a rota `t3code-dev://connections/new` quando a ação não estiver visível.
- Escolher o projeto no `New task`.
- Abrir `Thread settings` e escolher o modelo Pi e o nível de thinking.

## Driving it with adb + uiautomator

Preconditions:

- `doctor` passou para o mesmo `RUN_DIR`.
- Um pairing token novo foi criado com `--base-url "$MOBILE_ORIGIN"`.
- O APK é `com.t3tools.t3code.dev` e o Metro está no reverse ADB registrado.

- **Abrir conexões.** Execute `adb -s "$ADB_SERIAL" shell am start -W -a android.intent.action.VIEW -d 't3code-dev://connections/new' com.t3tools.t3code.dev`. A tela de conexão aparece.
- **Parear.** Preencha o origin completo `http://10.0.2.2:<server-port>` e o token que não foi persistido. A lista de projetos contém `T3 Code Pi verification`.
- **Escolher projeto.** Toque semanticamente em `New task`, selecione o projeto seedado e avance para a thread nova.
- **Escolher modelo.** Abra `Thread settings`. A árvore contém a seleção do provider Pi; escolha `pi/openai-codex/gpt-5.6-sol` e confirme o texto `GPT-5.6 Sol · Full`.
- **Registrar.** Se a tarefa precisar de evidência visual, rode `helpers/verify-mobile-pi.sh capture pair-and-model`.

## Gotchas

- `127.0.0.1` no origin aponta para o Android, não para o host; use `10.0.2.2` no emulador.
- Token pareado ou expirado não deve ser repetido; gere outro com o mesmo `BASE_DIR`.
- Um picker sem o grupo Pi geralmente indica `settings.json`/`BASE_DIR` divergente, não falha da UI.
- A presença do APK só prova a variante; `doctor` também precisa provar Metro e backend deste checkout.
