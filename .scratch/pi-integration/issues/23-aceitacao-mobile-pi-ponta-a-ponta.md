# Aceitação ponta a ponta: mobile na LAN conversando com o Pi

Type: task
Status: resolved
Blocked by: —

## Pergunta

Executar e registrar a prova final do destino no ambiente isolado já preparado:

- iniciar o T3 integrado sem afetar o vanilla;
- conectar o APK de desenvolvimento pela LAN/Tailscale;
- selecionar uma instância/modelo Pi scoped no mobile;
- enviar texto e imagem em uma thread real;
- observar extensões pessoais e ao menos um subagente trabalhando como tool
  calls genéricas;
- observar o MCP nativo do T3 disponível somente ao Pi principal;
- interromper/retomar ao menos uma sessão e confirmar ausência de processo
  órfão;
- receber o resultado final na mesma thread do celular.

Registrar comandos, logs e evidência visual/funcional reproduzível. Este ticket
não adiciona UI própria do Pi nem amplia o escopo; falhas encontradas voltam
como tickets específicos, em vez de serem escondidas na prova de aceitação.

## Comments

- O pareamento pela LAN foi concluído no servidor isolado `14273` e o grupo Pi
  passou a aparecer no picker mobile.
- A primeira mensagem chegou ao Pi e terminou no mesmo thread, mas a resposta
  apareceu duplicada. O servidor registrou um único turno e uma única mensagem;
  o bug foi separado no ticket 24.
- A interrupção chegou ao Pi e gerou `turn.aborted`, mas a ingestão manteve a
  sessão como `running`. O bug compartilhado por web e mobile foi separado no
  ticket 27.
- O ticket 27 foi implementado no commit `60a60f89a` e validado com Pi real na
  web, incluindo novo envio na mesma thread e ausência de processo órfão. A
  prova equivalente no celular fica nesta aceitação, junto da validação do
  ticket 24.
- O ticket 24 preserva espaços e quebras de linha nos deltas do Pi e passou nos
  testes focados do adapter. A repetição no celular também passou: o thread
  persistiu uma única resposta `WAYFINDER`.

## Answer

A aceitação foi concluída no servidor isolado `14273`, sem tocar no T3 vanilla
em `3773`, usando o APK de desenvolvimento no emulador Android conectado pela
LAN/reverse ADB.

- O picker mobile mostrou os modelos scoped do Pi; a thread foi salva com
  `pi/openai-codex/gpt-5.6-sol` (`GPT-5.6 Sol · Full`).
- Uma mensagem com texto e uma imagem `image/png` chegou ao mesmo thread e
  respondeu `WAYFINDER`. O estado persistido contém uma mensagem do usuário
  com um anexo e uma única mensagem do assistente — sem duplicação.
- A extensão pessoal de subagentes executou `subagent_spawn` e
  `subagent_wait`; o resultado entregue no mobile foi `SUBAGENT-RPC-OK` como
  tool call genérica. O MCP nativo do T3 foi chamado pelo Pi principal via
  `t3_preview_status`; o subagente não emitiu chamada `t3_*`.
- Um `bash` bloqueante (`tail -f /dev/null`) foi interrompido pelo botão do
  mobile. O turno terminou como `interrupted`, o processo filho desapareceu,
  e um novo envio na mesma thread respondeu `RESUME-OK`.
- Depois da conclusão não havia processo Pi nem processo filho órfão. Não foram
  usados `/quota` ou `/hud`.

Não foi necessário alterar código nesta aceitação; o runtime isolado recebeu
somente a configuração do provider Pi necessária para o picker e a execução.
