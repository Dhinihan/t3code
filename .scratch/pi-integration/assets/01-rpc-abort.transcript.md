# Ticket 01 — RPC abort transcript

Comando: `pi --mode rpc --approve --tools bash --thinking off ...`; o host
enviou `{"id":"abort-1","type":"abort"}` ao receber
`tool_execution_start` para `tail -f /dev/null`.

```text
{"type":"tool_execution_start","toolCallId":"call_MZZRqUN0hnwrZ0EAPbTQA1UO|fc_07a610549f820d82016a7cf92433788191bb883e31a193b407","toolName":"bash","args":{"command":"tail -f /dev/null"}}
{"type":"tool_execution_end","toolCallId":"call_MZZRqUN0hnwrZ0EAPbTQA1UO|fc_07a610549f820d82016a7cf92433788191bb883e31a193b407","toolName":"bash","result":{"content":[{"type":"text","text":"Command aborted"}],"details":{}},"isError":true}
{"type":"message_start","message":{"role":"assistant","content":[],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.6-sol","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"error","errorMessage":"This operation was aborted","timestamp":1786575140570}}
{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"Use the bash tool to run exactly: tail -f /dev/null. Do not stop on your own."}],"timestamp":1786575138042}],"willRetry":false}
{"type":"agent_settled"}
{"id":"abort-1","type":"response","command":"abort","success":true}
```
