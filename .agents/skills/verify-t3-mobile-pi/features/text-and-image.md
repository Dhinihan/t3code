# Enviar texto e imagem

O usuário pode iniciar uma thread no celular com texto e uma imagem, acompanhar o Pi trabalhando e receber uma única resposta final na mesma thread, enquanto o anexo fica persistido no T3.

## Sub-features

- `new-thread` — inicia a tarefa pelo composer mobile.
- `image-picker` — anexa `t3-wayfinder.png` pelo pipeline real do dispositivo.
- `single-response` — mostra uma resposta final `WAYFINDER` sem duplicação.
- `attachment-persisted` — mantém exatamente um anexo na mensagem do usuário.

## How to get to it (user POV)

- Tocar `New task` na home.
- Escolher um projeto conectado.
- Usar `Add attachment` no composer de thread.
- Tocar `Start task` numa thread nova ou `Send` numa thread existente.

## Driving it with adb + uiautomator

Preconditions:

- A feature [Parear e selecionar o Pi](./pair-and-select-pi.md) passou.
- `helpers/verify-mobile-pi.sh prepare-image "$PWD/apps/mobile/assets/android-icon-mark.png"` enviou `/sdcard/Pictures/t3-wayfinder.png`.
- A thread está configurada para `pi/openai-codex/gpt-5.6-sol` e `GPT-5.6 Sol · Full`.

- **Abrir tarefa.** Inspecione a árvore e acione `New task`. Escolha o projeto seedado; a tela de draft aparece.
- **Anexar imagem.** Acione `Add attachment`, escolha `t3-wayfinder.png` na galeria do emulador e confirme a miniatura no composer.
- **Enviar.** Digite um prompt determinístico pedindo que a resposta contenha `WAYFINDER` e acione `Start task`. O texto do usuário e o anexo aparecem na thread.
- **Aguardar.** Recolha a árvore até desaparecer `Working for ...` e aparecer a resposta do assistente. Capture `text-and-image-final`.
- **Verificar persistência.** Rode `helpers/verify-mobile-pi.sh db-proof`. Para esta primeira rodada, a saída precisa mostrar uma mensagem de usuário com `messages_with_attachments = 1` e exatamente uma mensagem de assistente no mesmo `thread_id`.

## Gotchas

- Um `item.completed` e uma mensagem final podem aparecer em momentos diferentes; aguarde o estado terminal antes de contar respostas.
- A tela final sozinha não prova o anexo; confira o XML da thread e a contagem SQLite.
- Não use um setter de draft nem injete linha SQLite para declarar que o upload funcionou.
- Se o picker não indexar a imagem, rode o broadcast de media scanner do helper e reabra o picker.
