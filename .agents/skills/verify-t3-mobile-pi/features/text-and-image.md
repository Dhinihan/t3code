# Receita: enviar texto e imagem

Use esta receita quando a tarefa pedir o composer, o picker de imagens ou o caminho de anexo no dispositivo.

## How to get to it (user POV)

- Tocar `New task` na home.
- Escolher um projeto conectado.
- Usar `Add attachment` no composer de thread.
- Tocar `Start task` numa thread nova ou `Send` numa thread existente.

## Driving it with adb + uiautomator

Preconditions:

- O app já está pareado com a instância deste run e pronto para abrir uma thread.
- `helpers/verify-mobile-pi.sh prepare-image "$PWD/apps/mobile/assets/android-icon-mark.png"` enviou `/sdcard/Pictures/t3-wayfinder.png`.
- A thread está configurada para `pi/openai-codex/gpt-5.6-sol` e `GPT-5.6 Sol · Full`.

- **Abrir tarefa.** Inspecione a árvore e acione `New task`. Escolha o projeto seedado; a tela de draft aparece.
- **Anexar imagem.** Acione `Add attachment`, escolha `t3-wayfinder.png` na galeria do emulador e confirme a miniatura no composer.
- **Enviar.** Digite um prompt determinístico pedindo que a resposta contenha `WAYFINDER` e acione `Start task`. O texto do usuário e o anexo aparecem na thread.
- **Aguardar.** Recolha a árvore até desaparecer `Working for ...` e aparecer a resposta do assistente. Capture `text-and-image-final`.
- **Registrar persistência.** Se a tarefa exigir prova no estado persistido, rode `helpers/verify-mobile-pi.sh db-proof` depois do turno.

## Gotchas

- Um `item.completed` e uma mensagem final podem aparecer em momentos diferentes; aguarde o estado terminal antes de contar respostas.
- A tela final sozinha não prova o anexo; confira o XML da thread e a contagem SQLite.
- Não use um setter de draft nem injete linha SQLite para declarar que o upload funcionou.
- Se o picker não indexar a imagem, rode o broadcast de media scanner do helper e reabra o picker.
