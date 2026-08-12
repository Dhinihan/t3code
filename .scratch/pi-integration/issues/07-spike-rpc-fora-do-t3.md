# Spike: falar com `pi --mode rpc` fora do T3

Type: prototype
Status: resolved
Blocked by: —

## Pergunta

**Par empírico do ticket `01`, não sucessor dele.** Bloquear este spike pela
pesquisa documental era uma inversão: rodar o Pi e capturar o stream é a
evidência mais forte que existe sobre o protocolo, e `01` já exige transcripts
reais. Os dois podem correr juntos ou na mesma sessão — `01` cataloga a
superfície, este prova o comportamento sob estresse (interrupção, morte de
processo, carregamento de extensões).

Com um script descartável, fora do T3, antes que qualquer decisão de adapter seja
tomada em cima de uma leitura errada.

Construir o menor cliente possível que:

- Sobe `pi --mode rpc` como processo filho, no diretório de trabalho deste repo.
- Faz o handshake (se houver) e registra o que o Pi anuncia sobre si.
- Manda um turno de texto e imprime o stream de eventos cru, sem interpretar.
- Manda um segundo turno que **obrigue** uma chamada de ferramenta (ler um
  arquivo, por exemplo) e captura como a ferramenta e o resultado aparecem.
- Tenta interromper um turno longo no meio e observa o que acontece.
- Mata o processo do Pi no meio de um turno e observa o que fica para trás —
  sessão recuperável? processo órfão? arquivo de sessão corrompido?

Confirmar também que as extensões atuais de `~/.pi/agent` carregam sob
`--mode rpc` — se elas não carregarem em headless, o escopo inteiro muda de
forma, e isso precisa aparecer agora e não depois do adapter pronto.

Guardar os transcripts capturados como asset e linká-los aqui. É código
descartável: prova o contrato, não vira o adapter.

## Answer

Resolvido com evidência executada no Pi `0.84.1`, usando o modelo local
`openai-codex/gpt-5.6-luna` em `xhigh`. O harness é descartável e fala JSONL cru
com um processo filho; cada cenário usa `HOME`, `PI_CODING_AGENT_DIR` e
`PI_CODING_AGENT_SESSION_DIR` temporários. A configuração e `auth.json` foram
copiados somente para o diretório temporário; as extensões foram carregadas dos
paths atuais de `~/.pi/agent/extensions`.

### Veredito

- **Transporte:** JSON Lines em stdio. Comandos entram em stdin; respostas,
  eventos de sessão e pedidos de UI de extensão saem em stdout, uma linha JSON
  por registro. stderr ficou vazio nos cenários executados.
- **Handshake:** não existe uma mensagem espontânea de handshake/versionamento.
  O cliente deve iniciar o processo e consultar `get_state` e/ou
  `get_commands`. As respostas têm envelope `{ id, type: "response", command,
success, data|error }`; o `id` correlaciona request e response.
- **Estado anunciado:** `get_state` retornou modelo, provider/API, capacidades
  de entrada `text`/`image`, nível de thinking, `sessionId`, `sessionFile`,
  streaming/compaction, modos de fila, contagem de mensagens e auto-compaction.
- **Turno de texto:** `prompt` retorna sucesso antes do stream terminar. O
  stream observado foi `agent_start` → `turn_start` → mensagens do usuário e
  assistant → `message_update` com `text_start`/`text_delta`/`text_end` →
  `message_end` com usage e `stopReason` → `turn_end` → `agent_end` →
  `agent_settled`. O texto `SPI_TEXT_OK` chegou em três deltas.
- **Ferramenta:** a chamada aparece primeiro como `message_update` com
  `toolcall_start`/`toolcall_delta`/`toolcall_end` e um `toolCall` estruturado.
  Depois vêm `tool_execution_start`, `tool_execution_end`, `message_start` e
  `message_end` de `toolResult`, com `content`, `toolCallId`, `toolName` e
  `isError`. O turno seguinte pôde produzir `SPI_TOOL_READ_OK`.
- **Interrupção:** `abort` enviado enquanto `bash sleep 8` estava em execução
  produziu `tool_execution_end` com `isError: true` e `Command aborted`, um
  `toolResult` de erro e assistant `stopReason: "error"`,
  `errorMessage: "This operation was aborted"`, seguido de `agent_settled`.
  A resposta do comando `abort` foi `success: true`.
- **Morte do processo:** `SIGKILL` no meio do `bash` encerrou o Pi com
  `signal: SIGKILL`; o stream parou em `tool_execution_update`. O arquivo de
  sessão ficou com cinco linhas JSON válidas, sem cauda corrompida. Não houve
  descendente capturado nem processo sobrevivente após a limpeza por PID exato.
  O mesmo arquivo foi reaberto com `--session` e respondeu `RECOVERED`, logo a
  sessão é recuperável após essa morte abrupta.
- **Extensões:** o processo RPC carregou as extensões atuais fornecidas por
  path, sem erro em stderr. `get_commands` confirmou `hud`, `voice-stop`,
  `voice-last`, `voice`, `quota`, `btw`, `subagents` e `telegram-enable`; o
  stream também mostrou `extension_ui_request` (`setStatus`) emitido pelo
  `subagents`. Extensões sem slash command (`claude-memory`, `chrome`, `valyu`)
  não aparecem nessa lista, mas não impediram o carregamento headless. O
  harness não acionou side effects opcionais como voz, Telegram ou Chrome.

### Assets e reprodução

- Harness descartável: [`run-spike.mjs`](../assets/07-spike-rpc/run-spike.mjs)
- Fixture lido pela ferramenta: [`read-target.txt`](../assets/07-spike-rpc/fixtures/read-target.txt)
- Handshake/extensões cru: [`01-handshake-extensions.raw.jsonl`](../assets/07-spike-rpc/transcripts/01-handshake-extensions.raw.jsonl)
- Turno de texto cru: [`02-text-turn.raw.jsonl`](../assets/07-spike-rpc/transcripts/02-text-turn.raw.jsonl)
- Turno com ferramenta cru: [`03-tool-turn.raw.jsonl`](../assets/07-spike-rpc/transcripts/03-tool-turn.raw.jsonl)
- Abort no bash cru: [`04-abort.raw.jsonl`](../assets/07-spike-rpc/transcripts/04-abort.raw.jsonl)
- Morte no turno cru: [`05-death.raw.jsonl`](../assets/07-spike-rpc/transcripts/05-death.raw.jsonl)
- Recuperação cru: [`06-recovery.raw.jsonl`](../assets/07-spike-rpc/transcripts/06-recovery.raw.jsonl)
- Sessão de morte/recuperação: [`session.jsonl`](../assets/07-spike-rpc/sessions/death-and-recovery/2026-08-12T22-56-49-241Z_019ff831-5059-7557-a587-dde50740450d.jsonl)
- Resultado agregado: [`run-summary.json`](../assets/07-spike-rpc/transcripts/run-summary.json)

Comando executado:

```bash
node .scratch/pi-integration/assets/07-spike-rpc/run-spike.mjs
```

O código é apenas prova do contrato e não implementa o adapter.
