# Adapter Pi: turnos, interrupção e eventos canônicos

Type: task
Status: open
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
