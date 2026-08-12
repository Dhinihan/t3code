# Superfície do RPC headless do Pi

Type: research
Status: resolved
Blocked by: —

## Pergunta

O que exatamente `pi --mode rpc` expõe? Este é o gargalo de quase todo o mapa: o
contrato Pi↔T3 não pode ser desenhado sem ele.

Levantar, com evidência (código do Pi instalado, `--help`, execução real,
transcripts capturados):

- **Transporte e enquadramento:** stdio? JSON-RPC? NDJSON? Um envelope próprio?
- **Ciclo de sessão:** como iniciar, continuar (`--session-id`, `--continue`,
  `--session-dir`), interromper e encerrar. O que acontece com uma sessão quando
  o processo morre.
- **Eventos emitidos:** inventário do que sai — texto/deltas, chamadas de
  ferramenta e seus resultados, uso de tokens, mudanças de modelo, erros.
- **Interrupção:** existe cancelamento no meio de um turno? Como é sinalizado?
- **Imagens:** o RPC aceita entrada com conteúdo binário/MIME? Em que forma?
- **Subagentes:** como as chamadas da extensão `subagents`
  (`subagent_spawn`/`wait`/`cancel`/`check`/`list`) aparecem no fluxo de eventos.
  São ferramentas comuns ou têm canal próprio?
- **Aprovações:** o Pi pode bloquear esperando aprovação neste ambiente? Como se
  garante que não bloqueie (modo `full-access`).
- **Handshake e versão:** existe negociação de versão/capabilities na abertura?
  O que o Pi informa sobre si.
- **Erros:** formato, e se são recuperáveis por sessão ou fatais ao processo.

Onde olhar: `~/.pi/agent` (config, extensões, `node_modules`), o pacote do `pi`
em `~/.npm-global`, e execução real capturando o stream.

Entregar como documento de findings no repo, com trechos de transcript reais —
não descrição de memória. Vários tickets vão zoomar nele.

## Answer

### Resultado curto

O Pi instalado no host é `@earendil-works/pi-coding-agent@0.84.1` (`pi --version`
retornou `0.84.1`). `--mode rpc` é um protocolo próprio, headless, sobre
stdin/stdout: JSONL estrito com framing por LF, sem envelope JSON-RPC 2.0 e sem
handshake inicial. O cliente envia comandos `{ "type": ..., "id"?: ... }` e
recebe no mesmo stdout respostas, eventos de sessão e pedidos de UI de extensão.

Evidência primária usada:

- pacote instalado: `/home/vinicius/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent`
- protocolo: `dist/modes/rpc/rpc-types.d.ts`, `dist/modes/rpc/rpc-mode.js`,
  `dist/modes/rpc/jsonl.js`, `dist/modes/json-event.js`
- cliente tipado: `dist/modes/rpc/rpc-client.d.ts` e `rpc-client.js`
- ciclo de sessão: `dist/main.js`, `dist/core/agent-session-runtime.js`,
  `dist/core/session-manager.js`
- eventos: `dist/core/agent-session.d.ts` e os tipos de
  `@earendil-works/pi-agent-core`/`pi-ai`
- subagentes carregados no host: `/home/vinicius/.pi/agent/extensions/subagents`
- UI de extensão exercitada com `examples/extensions/rpc-demo.ts`

Transcripts reais: [eventos e ferramenta](../assets/01-rpc-events.transcript.md),
[abort](../assets/01-rpc-abort.transcript.md),
[subagente](../assets/01-rpc-subagent.transcript.md),
[UI de extensão](../assets/01-rpc-ui.transcript.md) e
[sessão, controle e erros](../assets/01-rpc-session.transcript.md).

### Transporte e enquadramento

`rpc-mode.js` chama `takeOverStdout()` e só escreve registros serializados com
`JSON.stringify(value) + "\n"`. `jsonl.js` usa um leitor próprio que separa
somente em LF (`\n`), remove um `\r` opcional no fim da linha e preserva
separadores Unicode dentro de strings JSON. Portanto:

- entrada: um objeto JSON por linha em stdin;
- saída: um objeto JSON por linha em stdout;
- stderr fica disponível para diagnósticos do processo e não deve ser misturado
  ao stream RPC;
- não há método/request JSON-RPC, `jsonrpc: "2.0"` ou envelope de erro padrão;
  a correlação é pelo `id` opcional e pelo campo `command` da resposta;
- `prompt` é assíncrono: a resposta de aceitação pode sair antes dos eventos
  `agent_start`/`turn_start`, enquanto outros eventos e respostas podem
  intercalar-se;
- o leitor inicia `handleInputLine` sem serializar chamadas entre si. Um host
  deve correlacionar IDs e aguardar a resposta de uma troca de sessão antes de
  mandar outra operação dependente dela.

O stdout pode emitir `extension_ui_request` imediatamente durante o bind das
extensões, antes da primeira resposta do cliente. Isso é normal, não um
handshake.

### Comandos observados e ciclo de sessão

O `--help` real lista `--mode text|json|rpc`, `--session-id`, `--continue`,
`--session`, `--session-dir`, `--no-session`, `--approve`, `--tools`,
`--exclude-tools`, `--thinking`, `--provider` e `--model`. No RPC, o union de
`RpcCommand` também expõe:

- prompting: `prompt`, `steer`, `follow_up`, `abort`;
- sessão: `new_session`, `switch_session`, `fork`, `clone`, `get_entries`,
  `get_tree`, `get_messages`, `get_fork_messages`, `get_last_assistant_text`,
  `set_session_name`, `get_session_stats`, `export_html`;
- estado/modelo: `get_state`, `set_model`, `cycle_model`,
  `get_available_models`, `set_thinking_level`, `cycle_thinking_level`,
  `get_available_thinking_levels`;
- filas/recuperação: `set_steering_mode`, `set_follow_up_mode`, `compact`,
  `set_auto_compaction`, `set_auto_retry`, `abort_retry`;
- shell: `bash`, `abort_bash`.

`--session-id <id>` abre a sessão existente com esse ID no projeto ou cria uma
nova com esse ID. `--session-dir` controla onde os JSONL de sessão ficam.
`--continue` reabre a sessão mais recente. O comando RPC `new_session` troca o
runtime e responde `{ "cancelled": boolean }`; depois da troca, o host precisa
usar o novo `get_state` antes de continuar. `--no-session` usa uma sessão em
memória sem arquivo persistente.

Os arquivos de sessão são JSONL de entradas, incluindo mudanças de modelo e
thinking, mensagens e informações de sessão. Em teste, uma sessão chegou a
`agent_settled`, o processo foi terminado pelo PID capturado com `SIGKILL`, e
um segundo `pi --mode rpc` reabriu o mesmo `sessionId`, encontrou
`messageCount: 2` e recuperou `SESSION-PERSIST-OK`. `--continue` reabriu a mesma
sessão novamente.

EOF em stdin chama shutdown limpo e terminou com código 0 nos testes. O handler
de `SIGTERM` encerra com 143; `SIGHUP` encerra com 129. O `RpcClient.stop()`
envia `SIGTERM` e usa `SIGKILL` apenas como fallback após o timeout interno de
1 segundo.

### Eventos emitidos

O evento de sessão é a união dos eventos do agente com extensões do runtime:

- ciclo: `agent_start`, `turn_start`, `turn_end`, `agent_end` e
  `agent_settled`;
- mensagens: `message_start`, `message_update`, `message_end`;
- streaming assistant em `message_update.assistantMessageEvent`:
  `text_start`, `text_delta`, `text_end`, `thinking_start`,
  `thinking_delta`, `thinking_end`, `toolcall_start`, `toolcall_delta` e
  `toolcall_end`;
- ferramentas: `tool_execution_start`, `tool_execution_update` e
  `tool_execution_end` com `toolCallId`, nome, argumentos, resultado e
  `isError`;
- estado/runtime: `queue_update`, `thinking_level_changed`,
  `session_info_changed`, `bash_execution_update`, `entry_appended`;
- compaction/retry: `compaction_start`, `compaction_end`,
  `auto_retry_start`, `auto_retry_end`, `summarization_retry_scheduled`,
  `summarization_retry_attempt_start` e `summarization_retry_finished`;
- extensões: `extension_ui_request` e `extension_error`.

`toJsonEvent()` remove o campo cumulativo `partial` dos eventos de
`message_update`; o cliente deve reconstruir o texto/pensamento/dados de tool
pelos deltas e usar `message_end` como mensagem final autoritativa. O uso de
tokens/custo aparece no `message_end` da mensagem assistant e de forma
agregada em `get_session_stats` (`input`, `output`, `cacheRead`, `cacheWrite`,
`total`, `cost`). Mudanças de modelo aparecem na mensagem e na entrada de
sessão; `get_state` também retorna o modelo inteiro, nível de thinking e o
`sessionId`.

O transcript de controle observou literalmente `thinking_level_changed`,
`session_info_changed` e `bash_execution_update`; o transcript de prompt
observou deltas de texto e `agent_settled`; o transcript de ferramenta observou
o ciclo completo `tool_execution_start/update/end`.

### Interrupção e filas

`abort` chama `session.abort()`, que aborta o agente e espera o runtime voltar a
idle. Em teste, `tail -f /dev/null` terminou com `tool_execution_end` contendo
`"Command aborted"`, `isError: true`, seguido de uma mensagem assistant com
`stopReason: "error"` e `errorMessage: "This operation was aborted"`,
`agent_end` e `agent_settled`; a resposta do comando foi `success: true`.
`abort_bash` é a variante específica para o bash em execução.

`steer` não é cancelamento imediato: coloca uma mensagem na fila para ser
entregue depois do turno assistant atual e suas tool calls. `follow_up` espera
também as mensagens de steering pendentes. `queue_update` expõe as filas e
`pendingMessageCount` aparece em `get_state`.

### Imagens

`prompt`, `steer` e `follow_up` aceitam `images?: ImageContent[]`. O formato é
conteúdo JSON com `{ "type": "image", "data": "<base64>",
"mimeType": "image/png" }`; não existe frame binário separado. O teste
enviou uma imagem PNG 1×1 base64 e o evento `message_start` devolveu o mesmo
bloco `image` no conteúdo da mensagem user. O modelo Luna reporta
`input: ["text", "image"]` em `get_state`.

### Subagentes

A extensão instalada registra os tools comuns `subagent_spawn`,
`subagent_wait`, `subagent_cancel`, `subagent_check` e `subagent_list`. Eles
não ganham um canal RPC especial: aparecem exatamente como qualquer outra
tool, com `message_update` de tool call, `tool_execution_start/update/end` e
mensagens `toolResult`.

`subagent_spawn` é fire-and-forget e retorna um ID (`sa-1` no teste), título,
harness, modelo e cwd; a implementação documenta limite de quatro subagentes
rodando. `subagent_wait` aceita IDs, emite updates `Waiting for ...` e retorna
um bloco por subagente com status/output. `cancel`, `check` e `list` têm o
comportamento correspondente.

O teste real gerou `sa-1` com `harness: "pi"`,
`model: "openai-codex/gpt-5.6-luna"` e `reasoning_effort: "xhigh"`; o resultado
chegou pelo `tool_execution_end` de `subagent_wait` como `SUBAGENT-RPC-OK`.
No backend Pi, o filho é uma sessão headless in-process com seu próprio
contexto; os tools de orquestração e `ask_user` são excluídos do filho.

### Aprovações e modo sem UI

Pi não tem um modo RPC chamado `full-access`. A flag `--approve` (`-a`) é
explicitamente “Trust project-local files for this run”: ela resolve o trust
do projeto e permite carregar `.agents`, extensões/skills e recursos locais.
Não é um handshake nem uma resposta a uma aprovação de cada comando.

No modo RPC, o contexto de trust é não-interativo (`hasUI: false`); sem
`--approve` ou uma decisão persistida de trust, a resolução de projeto cai em
não confiável e os recursos locais não devem ser tratados como carregados.
Isso é a configuração que evita o Pi parar esperando o seletor de trust.

Extensões ainda podem implementar suas próprias aprovações. O RPC fornece
`extension_ui_request` para `select`, `confirm`, `input`, `editor`, `notify`,
`setStatus`, `setWidget`, `setTitle` e `set_editor_text`; o host responde com
`extension_ui_response` contendo `value`, `confirmed` ou `cancelled`. O teste
com `rpc-demo.ts` produziu um pedido `input`, recebeu `UI-OK` e emitiu
`notify`. Se o host não responder, dialogs respeitam timeout/sinal quando a
extensão os fornece; em uma integração headless, o host deve consumir esses
pedidos ou escolher uma política explícita. `--approve` não desabilita gates
implementados por extensões.

### Handshake, versão e erros

`rpc-entry.js` apenas configura o processo (`pi-rpc`, variáveis de ambiente) e
chama `main(["--mode", "rpc", ...])`; `runRpcMode()` faz o bind das extensões,
inscreve-se na sessão e começa a ler stdin. Não há mensagem inicial de versão,
capabilities ou negociação. O host deve usar `get_state`,
`get_available_models`, `get_available_thinking_levels` e `get_commands` como
descoberta operacional, e registrar a versão do binário separadamente
(`0.84.1` nesta investigação).

Erros de comando são recuperáveis e locais à linha:

```json
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: ..."}
{"id":"bad-command","type":"response","command":"not_a_command","success":false,"error":"Unknown command: not_a_command"}
{"id":"bad-model","type":"response","command":"set_model","success":false,"error":"Model not found: no-such-provider/no-such-model"}
```

Uma chamada posterior de `get_state` continuou funcionando no mesmo processo.
Falhas de preflight de `prompt` são devolvidas como resposta `success: false`;
falhas depois que o turno começou aparecem na mensagem assistant de erro,
`agent_end` e `agent_settled`. `extension_error` carrega o caminho da
extensão, evento e texto do erro. Erros de CLI/configuração antes de o runtime
subir são fatais e saem por stderr com código não-zero; EOF e sinais produzem
shutdown do processo, não uma resposta RPC.

### Implicação para o driver T3

O driver deve possuir um processo Pi por sessão, manter stdout puro, ler LF
sem misturar stderr, atribuir IDs a todos os comandos que precisam de
correlação e aguardar `agent_settled`/respostas reais em vez de temporizadores.
Deve implementar `abort` e `abort_bash`, tratar `extension_ui_request` como
backpressure potencial, transportar imagens como base64/MIME e não esperar
um handshake que o Pi não envia. Para carregar extensões e skills do projeto
neste ambiente, iniciar com `--approve`; isso não substitui uma política para
dialogs de extensões. Para continuidade, usar `--session-dir` + `--session-id`
ou `--continue` e não `--no-session`.
