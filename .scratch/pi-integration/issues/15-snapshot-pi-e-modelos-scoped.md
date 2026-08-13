# Snapshot Pi e catálogo de modelos scoped

Type: task
Status: open
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
