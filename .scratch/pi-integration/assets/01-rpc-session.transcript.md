# Ticket 01 — RPC session/control/error transcript

## Control events

```text
{"type":"thinking_level_changed","level":"xhigh"}
{"type":"session_info_changed","name":"rpc-control"}
{"id":"thinking","type":"response","command":"set_thinking_level","success":true}
{"id":"name","type":"response","command":"set_session_name","success":true}
{"type":"bash_execution_update","id":"bash","delta":"RPC-BASH-OK"}
{"id":"bash","type":"response","command":"bash","success":true,"data":{"output":"RPC-BASH-OK","exitCode":0,"cancelled":false,"truncated":false}}
```

## Persistência depois de morte do processo e `--continue`

O primeiro processo chegou a `agent_settled`, foi encerrado pelo PID capturado
com `SIGKILL`, e um segundo processo reabriu a mesma sessão.

```text
first_exit={"code":null,"signal":"SIGKILL"} settled=true
second {"id":"resume-state","type":"response","command":"get_state","success":true,"data":{"sessionFile":"/tmp/pi-ticket01-rpc-session/2026-08-12T22-52-52-240Z_ticket01-persist.jsonl","sessionId":"ticket01-persist","messageCount":2,"pendingMessageCount":0}}
second {"id":"resume-last","type":"response","command":"get_last_assistant_text","success":true,"data":{"text":"SESSION-PERSIST-OK"}}
```

Executando novamente com `--continue` no mesmo `--session-dir` produziu o mesmo
`sessionId` e `messageCount: 2`.

## Erros recuperáveis

```text
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: Unexpected token 'o', \"not-json\" is not valid JSON"}
{"id":"bad-command","type":"response","command":"not_a_command","success":false,"error":"Unknown command: not_a_command"}
{"id":"bad-model","type":"response","command":"set_model","success":false,"error":"Model not found: no-such-provider/no-such-model"}
{"id":"after-errors","type":"response","command":"get_state","success":true,"data":{"sessionId":"ticket01-errors","messageCount":0,"pendingMessageCount":0}}
```
