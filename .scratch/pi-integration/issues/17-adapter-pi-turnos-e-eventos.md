# Adapter Pi: turnos, interrupção e eventos canônicos

Type: task
Status: resolved
Blocked by: 14, 15, 16

## Pergunta

Implementar o `ProviderAdapter` Pi sobre a camada de sessões, materializando
**Mapeamento de eventos Pi → modelo de eventos do T3**:

- `startSession`, `sendTurn`, `interruptTurn`, `stopSession`, listagem e leitura
  necessárias ao runtime T3;
- troca in-session de modelo e thinking antes de cada prompt;
- texto, reasoning e tools convertidos nos eventos canônicos genéricos;
- turno encerrado somente em `agent_settled`;
- subagentes preservados como tool calls comuns, sem threads ou eventos `task.*`;
- erros locais recuperáveis, incompatibilidade determinística sem retry e
  operações não suportadas devolvendo o erro/capability apropriado;
- política MVP já decidida para pedidos bloqueantes de UI de extensão.

Usar o test double do runtime para a cobertura larga definida em **Suíte do
adapter Pi e detecção de drift do Pi**, incluindo ordenação, interrupção,
processo morto e thread recuperável. Imagens e MCP permanecem em tickets
próprios.

## Answer

Implementado em `apps/server/src/provider/Layers/PiAdapter.ts`, sobre o seam de
`PiSessionManager`:

- `startSession`, `sendTurn`, `interruptTurn`, `stopSession`, `listSessions`,
  `hasSession`, `readThread`, `rollbackThread` e `stopAll` seguem o contrato
  `ProviderAdapterShape`;
- modelo (`provider/modelId`) e thinking (`thinking`) são aplicados via RPC
  antes do prompt, com troca in-session e validação do `providerInstanceId`;
- `message_update` produz texto/reasoning, o lifecycle de ferramentas usa
  `tool_execution_*`, e subagentes permanecem `collab_agent_tool_call`, sem
  threads filhas ou eventos `task.*`;
- `agent_settled` é o único terminal normal: emite exatamente
  `turn.completed` ou `turn.aborted`; `turn_end` não encerra o turno;
- erro de ferramenta e falha local de prompt deixam a sessão recuperável;
  morte do processo emite `runtime.error`/`session.exited` e remove apenas a
  sessão ativa; rollback, respostas interativas e anexos de imagem retornam
  erros tipados de operação não suportada;
- pedidos bloqueantes `select`/`confirm`/`input`/`editor` são cancelados pelo
  novo envio unidirecional `extension_ui_response` e geram aviso visível;
- o decoder Pi agora preserva os payloads e campos desconhecidos dos eventos,
  mantendo a tolerância a drift necessária para o adapter.

Cobertura adicionada em `PiAdapter.test.ts`, no contrato e no transporte RPC:
texto, reasoning, tools com erro, subagente genérico, `agent_settled`, abort,
erro local recuperável, UI bloqueante, processo morto, leitura da thread e
cancelamento unidirecional. A suíte focada passou com **6 arquivos / 47 testes**;
`pnpm --filter t3 typecheck` e `git diff --check` também passaram. O lint focado
fica bloqueado somente pelo achado preexistente de `process.platform` na linha
63 de `PiRpcConnection.ts`, pertencente ao ticket 14.
