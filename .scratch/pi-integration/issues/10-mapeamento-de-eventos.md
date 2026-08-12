# Mapeamento de eventos Pi → modelo de eventos do T3

Type: grilling
Status: open
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
