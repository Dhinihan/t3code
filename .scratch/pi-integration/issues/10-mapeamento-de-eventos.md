# Mapeamento de eventos Pi → modelo de eventos do T3

Type: grilling
Status: resolved
Blocked by: 01, 04, 07

## Pergunta

O coração do adapter: cada evento que sai do Pi vira o quê na thread do T3? Esta
é a decisão que define o tamanho e a forma do código, e o escopo é explícito de
que o T3 deve **preservar o fluxo genérico de ferramentas** em vez de criar UI
própria.

Decidir, evento por evento:

- Texto e deltas de streaming → mensagens do assistente.
- Chamadas de ferramenta do Pi → o modelo genérico de tool call do T3. O T3
  espera campos que o Pi não fornece (ou o contrário)? O que se perde.
- **Subagentes**: `subagent_spawn`/`wait`/`cancel`/`check`/`list` chegam como
  ferramentas comuns. O escopo diz para transportá-las genericamente — sem
  threads filhas, sem FleetView. Confirmar que a UI genérica exibe isso de forma
  compreensível, e o que fazer com resultados longos de subagente.
- Erros: quais são de turno (thread continua) e quais são fatais (thread morre
  recuperável).
- Uso de tokens e custo: o T3 mostra isso hoje — o Pi fornece o suficiente?
- O que **não** é suportado e retorna erro de backend, conforme o escopo permite.
  Fazer a lista explícita agora, para não descobrir em produção.

Também: aprovações e questionários. O escopo diz que o Pi não os usa neste
ambiente — decidir o que o adapter faz se um chegar mesmo assim, em vez de
travar em silêncio.

## Answer

### Ciclo e mensagens

Um turno do T3 corresponde ao ciclo completo do agente Pi, não a cada chamada
interna ao modelo. `agent_start` abre o ciclo e `agent_settled` é o terminal
autoritativo: nele o adapter emite exatamente um `turn.completed` ou
`turn.aborted`, mantendo o `turnId` canônico criado no início.

`turn_start` e `turn_end` são limites internos do Pi e não mudam o lifecycle do
turno T3. Uma execução real com ferramenta mostrou
`tool_execution_end → turn_end → turn_start → turn_end → agent_end → agent_settled`;
follow-ups, steering e entrega de resultados de subagentes também podem ocorrer
depois de um `turn_end`.

Os deltas `text_delta` viram `content.delta` de `assistant_text`; deltas de
thinking viram `reasoning_text`. `message_end` é a forma final autoritativa para
fechar o item sem duplicar o texto já transmitido. Falhas anteriores a
`agent_settled`, como erro de preflight ou morte do processo, seguem os caminhos
de erro descritos abaixo.

### Ferramentas genéricas

`tool_execution_start`, `tool_execution_update` e `tool_execution_end` são a
fonte autoritativa do lifecycle `item.started`/`item.updated`/`item.completed`.
Os eventos `toolcall_*` do streaming são duplicatas da intenção do modelo e não
criam outro item. O `toolCallId` correlaciona todo o ciclo; nome, argumentos,
resultado e `isError` ficam no payload genérico.

Ferramentas reconhecíveis usam os tipos canônicos existentes, como
`command_execution`, `file_change`, `web_search`, `image_view` e
`mcp_tool_call`; as demais usam `dynamic_tool_call`. Resultados longos são
limitados no preview persistido/transportado pela timeline, enquanto o payload
bruto fica somente no caminho diagnóstico do adapter.

### Ferramentas de subagente

Mapear `subagent_spawn`, `subagent_wait`, `subagent_cancel`, `subagent_check` e
`subagent_list` como tool calls do Pi no fluxo genérico do T3. O adapter não
emite `task.*`, não cria subagentes nativos do T3 e não os projeta na Agents
surface.

Essa tradução é somente observacional e não interfere na orquestração do Pi. A
extensão registra e executa esses cinco tools dentro do processo Pi; seu manager
mantém os filhos, e os próprios resultados de `spawn`/`wait`/`check`/`cancel`/`list`
voltam ao agente principal como tool results. O transcript real do ticket 01
também comprovou `subagent_spawn` seguido de `subagent_wait` e entrega do
resultado ao agente principal. Portanto, ocultar a semântica nativa de agentes
do T3 preserva a capacidade do Pi de criar e monitorar seus filhos normalmente.

### Erros de ferramenta, turno e sessão

Erros de ferramenta fecham o item com status `failed`, mas não encerram a
sessão: o agente Pi ainda pode observar o tool result e se recuperar no mesmo
turno. Um erro final do modelo fecha somente o turno como `failed` e deixa a
sessão Pi disponível para a próxima mensagem.

Somente falha do processo Pi, violação do protocolo RPC ou sessão
ausente/corrompida/incompatível é fatal para a sessão ativa. Nesses casos, o
adapter emite erro de runtime e saída de sessão; a thread durável do T3 continua
preservada conforme a decisão da tarefa 09.

### Pedidos interativos de extensões

O fluxo atual do Pi do usuário não depende de input bloqueante de extensão;
interações normais acontecem por prompts. Se uma extensão futura emitir
`select`, `confirm`, `input` ou `editor` bloqueante pelo RPC, o adapter responde
imediatamente com cancelamento, emite um aviso visível e deixa o turno
continuar. Não transforma esse caso em falha de turno.

Eventos de apresentação sem espera, como `setStatus`, `setWidget` e `setTitle`,
não exigem resposta do host e podem ser ignorados no MVP.

### Eventos desconhecidos

Eventos Pi desconhecidos que sejam somente informativos são ignorados, com
aviso diagnóstico e preservação do payload bruto para investigação. O adapter
falha explicitamente apenas quando o evento desconhecido exige uma resposta do
host ou impede manter corretamente o ciclo de sessão/turno.

### Uso e custo

Custo não será calculado nem exibido no MVP. Não haverá UI, modelo ou
agregação nova para esse dado; o suporte fica deferido.

Métricas de tokens atravessam somente no mínimo necessário para preencher o
contrato genérico que o T3 já suporta. O adapter não cria novas métricas nem
abre escopo adicional de contabilização nesta integração.
