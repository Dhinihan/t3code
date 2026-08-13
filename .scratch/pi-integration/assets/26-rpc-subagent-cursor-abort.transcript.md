# Ticket 26 — Pi subagent abort with a Cursor-backed parent

Reprodução real no Pi `0.84.1`, fora do T3, com o mesmo processo RPC e o
mesmo modelo do caso mobile:

```bash
pi --mode rpc --provider cursor --model grok-4.5 --thinking minimal \
  --approve --session-dir /tmp/pi-ticket-26/sessions \
  --session-id ticket26-raw
```

O prompt pediu uma única chamada `subagent_spawn` com `harness: "pi"`, cwd do
repositório e `reasoning_effort: "minimal"`. O stream relevante foi:

```text
{"type":"response","command":"prompt","success":true}
{"type":"agent_start"}
{"type":"tool_execution_start","toolName":"subagent_spawn","toolCallId":"cursor-pi-bridge-run-...-tool-1"}
{"type":"tool_execution_end","toolName":"subagent_spawn","isError":true,"result":{"content":[{"type":"text","text":"Subagent spawn aborted."}],"details":{}}}
{"type":"agent_end"}
{"type":"agent_settled"}
```

Não houve `tool_execution_update`, resultado do filho ou processo Pi filho. A
reprodução foi repetida no RPC cru e no ambiente T3 preservado da aceitação.
No segundo caso, o turno terminou com `errorMessage: "This operation was
aborted"`; a thread aceitou o envio seguinte.

## Diagnóstico

`Subagent spawn aborted.` é o texto fallback de `runTool` da extensão
`subagents`, usado quando o `AbortSignal` da ferramenta interrompe o efeito.
O caminho não é ausência de capability nem roteamento: a ferramenta foi
registrada e executada com `harness: "pi"`.

O backend Pi da extensão cria o filho como `AgentSession` in-process. Ao
carregar as extensões do filho, `pi-cursor-sdk` reutiliza estado global do
processo para o escopo da sessão Cursor. O `session_start` do filho troca o
escopo do pai; o ciclo de vida Cursor descarta o agente do pai e o sinal da
ferramenta externa é interrompido. Portanto o abort acontece durante o
startup/bind do filho, antes de existir um resultado de subagente.

O caso de sucesso do mesmo contrato, com `openai-codex/gpt-5.6-luna`, está em
[`01-rpc-subagent.transcript.md`](01-rpc-subagent.transcript.md).
