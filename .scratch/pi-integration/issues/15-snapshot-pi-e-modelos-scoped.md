# Snapshot Pi e catálogo de modelos scoped

Type: task
Status: resolved
Blocked by: 14

## Pergunta

Implementar o provider snapshot decidido em **Espelhar os modelos do Pi sem
quebrar a rebaseabilidade**:

- snapshot inicial `checking` com `models: []`;
- probe descartável a cada refresh padrão de cinco minutos, usando uma conexão
  para piso semver, `get_state` e catálogo;
- extensão-ponte interna, carregada apenas por `--extension`, que devolve
  `ctx.scopedModels` pelo RPC sem ler arquivos de configuração do Pi;
- fallback para `get_available_models` quando o escopo vier vazio;
- mapeamento `provider/modelId` para `ServerProviderModel`, com thinking por
  modelo como `optionDescriptors` e nível scoped como `currentValue` editável;
- status/erros coerentes com os providers existentes e refresh imediato quando
  um modelo selecionado desaparecer.

Cobrir o mapeamento e o probe com testes herméticos, inclusive escopo presente,
escopo ausente, thinking fixado, lista obsoleta e resposta inesperada da
extensão-ponte. Não implementar o adapter de turnos neste ticket.

## Answer

Implementado em arquivos novos sob `apps/server/src/provider/`:

- `PiProvider.ts` publica o snapshot inicial `checking`, executa o probe
  descartável com versão, `get_state`, compatibilidade e catálogo, e devolve
  estados `ready`/`warning`/`error` coerentes. O ciclo periódico fica a cargo
  de `makeManagedServerProvider`, que usa o refresh padrão de cinco minutos.
- `PiScopedModelsExtension.ts` é a ponte interna sem imports/configuração: o
  processo recebe `--extension`, executa `/t3-scoped-models <operationId>` e
  publica `{ model, thinkingLevel }` via `setStatus` correlacionado.
- O escopo tem precedência; escopo vazio cai para `get_available_models`.
  Modelos viram `provider/modelId`, com thinking por modelo e o nível scoped
  em `currentValue` editável. `isPiModelSelectionStale` deixa o refresh
  imediato explícito para o adapter do ticket 17.
- `PiRpcContract` preserva os campos da extensão necessários à correlação; o
  peer hermético foi ampliado para simular a ponte.

Cobertura: mapeamento, escopo presente/ausente, thinking fixado, catálogo
obsoleto, payload inesperado, extensão e probe completo contra o peer JSONL.
O adapter de turnos não foi implementado.

Verificações focadas:

- `vp test run ...` — 39 testes passaram;
- lint focado e `vp fmt --check` — passaram;
- o typecheck do pacote server ainda reporta falhas preexistentes do runtime
  do ticket 14 (`PiRpcConnection`, `PiRpcProtocol` e testes de compatibilidade);
  nenhum diagnóstico de tipo permaneceu nos arquivos novos deste ticket.
