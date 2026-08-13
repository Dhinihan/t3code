# Tools e MCP do Pi principal

O Pi mantém as extensões pessoais que o usuário já usa: subagentes aparecem como tool calls genéricas, enquanto o MCP nativo do T3 só existe no processo Pi principal e não vaza para o subagente.

## Sub-features

- `subagent-spawn` — solicita exatamente um `subagent_spawn` com `harness: "pi"`.
- `subagent-wait` — aguarda o mesmo id e recebe `SUBAGENT-RPC-OK`.
- `main-mcp` — chama `t3_preview_status` pelo Pi principal.
- `child-boundary` — não observa chamadas `t3_*` no registro do subagente.

## How to get to it (user POV)

- Enviar uma instrução na thread já pareada, usando o composer normal.
- Observar a atividade de tool na própria thread mobile.
- Ler a resposta final na mesma thread; não abrir uma thread T3 filha.

## Driving it with adb + uiautomator

Preconditions:

- Uma thread Pi já respondeu texto e imagem.
- O Pi real carrega a extensão pessoal de subagentes e a extensão MCP do T3 desta integração.
- O emulador consegue continuar no mesmo thread; não crie outro provider para “facilitar” a leitura.

- **Solicitar filho.** Envie uma instrução que peça uma única chamada `subagent_spawn` com `harness: "pi"`, seguida de `subagent_wait`, pedindo que o resultado seja exatamente `SUBAGENT-RPC-OK`. A thread mostra a atividade genérica.
- **Aguardar filho.** Atualize a árvore até a atividade terminar e a resposta aparecer. Capture `tools-subagent-final`.
- **Solicitar MCP principal.** Envie uma instrução separada pedindo `t3_preview_status` no Pi principal. A atividade correspondente aparece sem abrir um MCP no celular.
- **Inspecionar prova.** Rode `helpers/verify-mobile-pi.sh db-proof` e filtre os JSONL apenas pelos nomes `subagent_spawn`, `subagent_wait` e `t3_preview_status`. O resultado associa `t3_preview_status` ao principal e não encontra `t3_*` no registro do subagente.

## Gotchas

- `subagent_spawn` não cria uma thread T3 filha; contar uma nova thread seria provar o contrato errado.
- Não use `/quota` nem `/hud` como atalho de diagnóstico durante esta aceitação.
- Uma falha explícita de capability para combinações não suportadas é diferente de uma chamada Pi genérica bem-sucedida; registre ambas sem mascarar o caso.
- O resumo da atividade é evidência auxiliar; o JSONL do Pi e a ausência de processo filho são a confirmação de fronteira.
