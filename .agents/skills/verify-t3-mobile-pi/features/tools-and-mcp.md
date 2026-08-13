# Receita: tools e MCP do Pi principal

Use esta receita quando a tarefa pedir a observação de uma tool, de uma extensão Pi ou da fronteira entre o Pi principal e um subagente.

## How to get to it (user POV)

- Enviar uma instrução na thread já pareada, usando o composer normal.
- Observar a atividade de tool na própria thread mobile.
- Ler a resposta final na mesma thread; não abrir uma thread T3 filha.

## Como dirigir com adb + uiautomator

Preconditions:

- Uma thread Pi já está pareada e pronta para receber a instrução solicitada.
- O Pi real carrega a extensão pessoal de subagentes e a extensão MCP do T3 desta integração.
- Continue a thread atual quando a tarefa pedir continuidade; abra uma nova quando pedir isolamento.

- **Solicitar filho.** Envie uma instrução que peça uma única chamada `subagent_spawn` com `harness: "pi"`, seguida de `subagent_wait`, pedindo que o resultado seja exatamente `SUBAGENT-RPC-OK`. A thread mostra a atividade genérica.
- **Aguardar filho.** Atualize a árvore até a atividade terminar e a resposta aparecer. Capture `tools-subagent-final`.
- **Solicitar MCP principal.** Envie uma instrução separada pedindo `t3_preview_status` no Pi principal. A atividade correspondente aparece sem abrir um MCP no celular.
- **Registrar.** Rode `helpers/verify-mobile-pi.sh db-proof` se a tarefa exigir confirmação dos RPCs; filtre os JSONL pelos nomes relevantes ao cenário.

## Gotchas

- `subagent_spawn` não cria uma thread T3 filha; contar uma nova thread seria provar o contrato errado.
- Não use `/quota` nem `/hud` como atalho de diagnóstico durante esta receita.
- Uma falha explícita de capability para combinações não suportadas é diferente de uma chamada Pi genérica bem-sucedida; registre ambas sem mascarar o caso.
- O resumo da atividade é evidência auxiliar; o JSONL do Pi e a ausência de processo filho são a confirmação de fronteira.
