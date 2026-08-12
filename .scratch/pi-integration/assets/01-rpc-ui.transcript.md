# Ticket 01 — RPC extension UI transcript

Comando: `pi --mode rpc --approve --no-tools -e .../examples/extensions/rpc-demo.ts ...`;
o host enviou `extension_ui_response` com `value: "UI-OK"` ao pedido de input.

```text
{"type":"extension_ui_request","id":"ac232654-cb6a-49c1-a0a5-3d5871aaaab3","method":"setTitle","title":"pi RPC Demo"}
{"type":"extension_ui_request","id":"4668f519-532b-48be-800f-c7e4808b6305","method":"setWidget","widgetKey":"rpc-demo","widgetLines":["--- RPC Extension UI Demo ---","Loaded and ready."]}
{"type":"extension_ui_request","id":"0c5d4b7a-8c1d-4c12-bf1d-ac5eb1fc8775","method":"setStatus","statusKey":"rpc-demo","statusText":"Turns: 0"}
{"type":"extension_ui_request","id":"cf1c2bd8-4091-4fe8-bd86-20b0d3679e96","method":"input","title":"Enter a value","placeholder":"type something..."}
{"type":"extension_ui_request","id":"eb01b96b-77ee-4621-af86-3f71187921da","method":"notify","message":"You entered: UI-OK","notifyType":"info"}
{"id":"ui-prompt","type":"response","command":"prompt","success":true}
```
