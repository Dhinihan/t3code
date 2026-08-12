# Ticket 01 — RPC event transcript excerpts

Os registros abaixo foram copiados do stdout real de `pi --mode rpc` em
2026-08-12. São excertos selecionados; campos de alto volume (catálogo inteiro
de modelos e assinaturas de raciocínio) não foram repetidos.

## Prompt, deltas e settlement

Comando: `pi --mode rpc --approve --no-tools --thinking xhigh --session-dir /tmp/pi-ticket01-rpc-events --session-id ticket01-events`

```text
{"id":"prompt-1","type":"response","command":"prompt","success":true}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Reply exactly with RPC-EVIDENCE-OK and nothing else."}],"timestamp":1786575061259}}
{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"RPC"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"-E"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"VID"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"ENCE"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"-"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"OK"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"RPC-EVIDENCE-OK"}}
{"type":"agent_settled"}
```

## Built-in tool execution

Comando: `pi --mode rpc --approve --tools bash --thinking off ...`

```text
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"call_PlSS1JMJB7yRbwtKGSRlyQeZ|fc_079d8764c1876a5b016a7cf8f6cd888191b11cbe428dcede3d","name":"bash","arguments":{"command":"printf RPC-TOOL-OK"}}}}
{"type":"tool_execution_start","toolCallId":"call_PlSS1JMJB7yRbwtKGSRlyQeZ|fc_079d8764c1876a5b016a7cf8f6cd888191b11cbe428dcede3d","toolName":"bash","args":{"command":"printf RPC-TOOL-OK"}}
{"type":"tool_execution_update","toolCallId":"call_PlSS1JMJB7yRbwtKGSRlyQeZ|fc_079d8764c1876a5b016a7cf8f6cd888191b11cbe428dcede3d","toolName":"bash","args":{"command":"printf RPC-TOOL-OK"},"partialResult":{"content":[{"type":"text","text":"RPC-TOOL-OK"}],"details":{}}}
{"type":"tool_execution_end","toolCallId":"call_PlSS1JMJB7yRbwtKGSRlyQeZ|fc_079d8764c1876a5b016a7cf8f6cd888191b11cbe428dcede3d","toolName":"bash","result":{"content":[{"type":"text","text":"RPC-TOOL-OK"}]},"isError":false}
{"type":"agent_settled"}
```
