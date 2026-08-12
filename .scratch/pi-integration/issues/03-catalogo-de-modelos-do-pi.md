# Catálogo de modelos e esforço do Pi

Type: research
Status: resolved
Blocked by: —

## Pergunta

Ficou decidido que o T3 **espelha** os modelos que o Pi conhece, em vez de
mostrar uma entrada única "Pi". Para isso é preciso saber de onde vem essa lista
e como a escolha é transmitida.

Levantar:

- Onde vive o catálogo: `~/.pi/agent/models.json`, `models-store.json`,
  `pi update` — qual é a fonte de verdade e quem a atualiza.
- Formato de uma entrada de modelo: id, provider, nome de exibição,
  capabilities, limites de contexto, custo.
- Como o modelo é selecionado: `--provider` / `--model` na abertura do processo,
  ou dá para trocar **dentro** de uma sessão viva pelo RPC (o equivalente ao
  Ctrl+P da TUI)?
- Como o nível de esforço (`--thinking`: off…max) é expresso e se ele também é
  trocável em sessão.
- O que acontece quando o usuário atualiza o Pi e o catálogo muda debaixo de uma
  lista já espelhada pelo T3 — há versionamento ou timestamp para detectar?
- Quais modelos estão de fato autenticados/prontos neste host (`pi auth`), já que
  espelhar o catálogo inteiro exporia modelos inutilizáveis na UI.

**Forma-alvo já conhecida** (levantada durante o charting, ver `12`): o T3 espera
`ServerProviderModel` = `{slug, name, shortName?, subProvider?, isCustom,
isDefault?, isLegacy?, capabilities}`, e `capabilities` é só
`{optionDescriptors?: (select | boolean)[]}`. O `--thinking` do Pi encaixa como
um descriptor `select`. Então esta pesquisa deve terminar mostrando **como uma
entrada real do Pi vira um `ServerProviderModel`** — inclusive o que não tem
correspondente e se perde.

Ponto crítico para `12`: o Cursor descobre modelos **sob demanda pelo protocolo**
(`cursor/list_available_models`), sem ler arquivos do disco. Descobrir se o Pi
oferece equivalente pelo RPC; se não oferecer, a alternativa é ler
`~/.pi/agent/models.json` diretamente, o que acopla a integração ao layout de
arquivos do Pi — dizer explicitamente qual dos dois é possível.

Entregar como documento de findings no repo, com um exemplo real de entrada de
modelo deste computador.

## Answer

### Veredito

O Pi oferece descoberta de modelos pelo próprio RPC. O T3 não precisa ler
`~/.pi/agent/models.json` nem `models-store.json` para construir a lista de
modelos: deve iniciar o Pi com a configuração/extensões do ambiente e pedir
`get_available_models`. Essa resposta já é a visão disponível do runtime,
filtrada por autenticação/configuração. A escolha em uma sessão viva também é
suportada: `set_model` recebe `provider` e `modelId`; o nível de thinking é
alterável com `set_thinking_level`.

Não existe no RPC um comando de `refresh_models`, nem metadados de catálogo
(`generatedAt`, `checkedAt`, `lastModified` ou `etag`). Portanto, a fronteira
de atualização é o processo Pi: descobrir ao iniciar/refrescar o runtime e
tratar uma nova sessão do Pi como o ponto de revalidação. Um processo já vivo
não anuncia automaticamente que `pi update --models` mudou seu catálogo.

### De onde vem o catálogo

Há três camadas, e nenhuma delas isoladamente é “o catálogo inteiro”:

1. **Catálogo estático nativo:** o pacote instalado
   `@earendil-works/pi-ai` traz os dados gerados em
   `node_modules/@earendil-works/pi-ai/dist/providers/data/*.json` e os monta
   em `models.generated.js`. O módulo `providers/all.js` expõe esses providers
   e lê `.manifest.json`; neste host o `generatedAt` do pacote é
   `2026-08-07T05:53:06.539Z`. A fonte é o pacote/versão instalada, não
   `models.json`.

2. **Configuração local/custom:** `~/.pi/agent/models.json` é carregado pelo
   `ModelConfig` a cada `ModelRuntime.refresh()`. A documentação diz que ele
   é para providers/modelos customizados, pode ser editado durante a sessão e
   é recarregado ao abrir o picker `/model`. Neste host ele define os
   providers `ollama`, `cliproxy` e `cliproxy-openai`, com 1, 4 e 1 modelos,
   respectivamente. Um modelo custom não precisa repetir `provider` no objeto:
   o provider do arquivo é aplicado pelo runtime.

3. **Overlay dinâmico/cache:** `~/.pi/agent/models-store.json` é um cache
   persistido de catálogos publicados por providers dinâmicos, principalmente
   os overlays de `pi.dev`. O código restaura um overlay apenas quando o
   `lastModified` remoto é mais novo que o `generatedAt` local, faz merge por
   `id` e atualiza o arquivo com `checkedAt`, `lastModified` e `etag`. Neste
   host o arquivo tem entradas para `openai-codex` (7 modelos) e `anthropic`
   (13 modelos). Ele é cache, não fonte primária; não deve ser a API do T3.

`pi update --models` é o atualizador explícito: cria um `ModelRuntime` apontando
para `auth.json`/`models.json` do agent dir e chama `modelRuntime.refresh` com
`allowNetwork: true` e `force: true`; o refresh publica os resultados no
`models-store.json`. O endpoint usado pelo overlay é
`https://pi.dev/api/models/providers/<provider>`, com `If-None-Match` quando há
`etag` cacheado. O intervalo normal de revalidação é de quatro horas, mas o
`--models` força a consulta.

Evidência primária:

- pacote Pi: `@earendil-works/pi-coding-agent` `docs/models.md:1-3,197-211`;
- carregamento do catálogo nativo: `.../pi-ai/dist/providers/all.js:12,47-64` e
  `.../pi-ai/dist/providers/data/.manifest.json`;
- overlay e timestamps: `.../pi-coding-agent/dist/core/remote-catalog-provider.js:31-117`;
- atualizador: `.../pi-coding-agent/dist/package-manager-cli.js:350-370,626-635`;
- reload de `models.json` e snapshot do runtime:
  `.../pi-coding-agent/dist/core/model-runtime.js:166-196,501-544`.

### Formato de uma entrada Pi

O `Model` devolvido pelo RPC tem, no mínimo, esta forma documentada:

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

Para `models.json`, os campos de configuração são `id`, `name`, `api`,
`reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`,
`cost`, `compat` e alguns campos de transporte (`baseUrl`, `headers` e
`samplingParams`). `name` cai para `id`; `reasoning` cai para `false`; os
defaults documentados são `input: ["text"]`, `contextWindow: 128000`,
`maxTokens: 16384` e custo zero.

`thinkingLevelMap` usa as chaves Pi `off`, `minimal`, `low`, `medium`, `high`,
`xhigh` e `max`. Valor string significa que o nível é suportado e qual valor
será enviado ao provider; `null` esconde o nível; chaves omitidas mantêm os
defaults dos níveis padrão. Isso é metadado do runtime, não apenas uma lista
de labels.

### Seleção e troca em sessão

Na abertura, o Pi aceita `--provider <name>` e `--model <pattern|id>`; também
aceita a forma `provider/id` e o sufixo `:thinking`. O RPC tem as operações:

```json
{"type":"get_available_models"}
{"type":"set_model","provider":"openai-codex","modelId":"gpt-5.6-luna"}
{"type":"cycle_model"}
{"type":"get_available_thinking_levels"}
{"type":"set_thinking_level","level":"max"}
{"type":"cycle_thinking_level"}
```

`set_model` compara exatamente `provider` e `id` contra o snapshot disponível;
se não encontrar, responde erro `Model not found: provider/modelId`. Portanto o
T3 deve preservar os dois componentes no slug/estado da seleção. O handler
confirma isso em `.../dist/modes/rpc/rpc-mode.js:364-401`; a documentação do
protocolo está em `docs/rpc.md:215-310`.

### Thinking

O nível é trocável em uma sessão viva, não apenas uma flag de abertura. O
comando RPC usa os nomes Pi (`off`…`max`), enquanto o `thinkingLevelMap` deixa o
Pi traduzir internamente para o valor do provider. Para o T3, a opção deve
guardar o nível Pi; não deve guardar diretamente o valor de transporte.

O descriptor recomendado é:

```json
{
  "id": "thinking",
  "label": "Thinking",
  "type": "select",
  "options": [
    { "id": "off", "label": "Off" },
    { "id": "minimal", "label": "Minimal" },
    { "id": "low", "label": "Low" },
    { "id": "medium", "label": "Medium" },
    { "id": "high", "label": "High" },
    { "id": "xhigh", "label": "Extra High" },
    { "id": "max", "label": "Max" }
  ]
}
```

Os options efetivos devem ser derivados do `thinkingLevelMap`: remover os
níveis que tenham valor `null`, manter os níveis suportados e aplicar os
defaults padrão quando a chave estiver omitida. O RPC também pode confirmar a
lista do modelo atualmente selecionado via `get_available_thinking_levels`.

### Exemplo real deste host

Versão instalada: `pi 0.84.1`.

O comando real, em um processo RPC sem sessão, com as extensões deste host
carregadas, retornou para `openai-codex/gpt-5.6-luna`:

```json
{
  "id": "gpt-5.6-luna",
  "name": "GPT-5.6 Luna",
  "api": "openai-codex-responses",
  "provider": "openai-codex",
  "baseUrl": "https://chatgpt.com/backend-api",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 272000,
  "maxTokens": 128000,
  "cost": {
    "input": 0.2,
    "output": 1.2,
    "cacheRead": 0.02,
    "cacheWrite": 0.25,
    "tiers": [
      {
        "inputTokensAbove": 272000,
        "input": 0.4,
        "output": 1.8,
        "cacheRead": 0.04,
        "cacheWrite": 0.5
      }
    ]
  },
  "thinkingLevelMap": {
    "minimal": "low",
    "xhigh": "xhigh",
    "max": "max"
  },
  "compat": {
    "supportsOpenAIGrammarTools": true,
    "supportsAdditionalTools": true,
    "supportsToolSearch": true
  }
}
```

No mesmo processo, `get_available_thinking_levels` retornou
`["off","minimal","low","medium","high","xhigh","max"]`; depois
`set_model` para `gpt-5.6-sol` e `set_thinking_level` para `minimal` retornaram
sucesso, e `get_state` mostrou o novo modelo/nível. Isso confirma a troca viva
sem depender da TUI.

### Modelagem como `ServerProviderModel`

O slug precisa ser canônico porque um provider Pi pode expor IDs iguais em
providers diferentes (`anthropic/claude-fable-5` e
`cliproxy/claude-fable-5`, por exemplo). O padrão existente do OpenCode usa
`slug: \`${provider.id}/${model.id}\`` (`apps/server/src/provider/Layers/OpenCodeProvider.ts:235-245`).

Para a entrada real acima, o mapeamento recomendado é:

```json
{
  "slug": "openai-codex/gpt-5.6-luna",
  "name": "GPT-5.6 Luna",
  "subProvider": "openai-codex",
  "isCustom": false,
  "capabilities": {
    "optionDescriptors": [
      {
        "id": "thinking",
        "label": "Thinking",
        "type": "select",
        "options": [
          { "id": "off", "label": "Off" },
          { "id": "minimal", "label": "Minimal" },
          { "id": "low", "label": "Low" },
          { "id": "medium", "label": "Medium" },
          { "id": "high", "label": "High" },
          { "id": "xhigh", "label": "Extra High" },
          { "id": "max", "label": "Max" }
        ]
      }
    ]
  }
}
```

Regras do mapeamento:

- `provider + "/" + id` → `slug`; ao despachar, separar novamente e enviar
  `set_model { provider, modelId }`.
- `name` → `name`; se ausente, usar `id`.
- `provider` → `subProvider` (ou um label humanizado, se a apresentação do
  provider Pi fizer essa tradução).
- `reasoning`/`thinkingLevelMap` → um descriptor `select` `thinking`.
- `models.json` custom pode ser marcado `isCustom: true` somente se o driver
  tiver essa informação por outra via. O RPC `Model` não carrega a origem do
  modelo, então a distinção custom vs. nativo não é recuperável apenas de
  `get_available_models`; o default seguro para o snapshot RPC é `false`.
- `isDefault`, `isLegacy` e `shortName` não existem no `Model` do Pi. Omitir;
  não inferir `isDefault` do modelo atualmente selecionado.
- `api`, `baseUrl`, `input`, `contextWindow`, `maxTokens`, `cost`, `compat`,
  `samplingParams` e os valores de transporte de `thinkingLevelMap` não têm
  campo correspondente em `ServerProviderModel`/`ModelCapabilities`; eles se
  perdem no snapshot T3. Isso é aceitável para a UI atual, mas o adapter deve
  continuar usando o RPC Pi, pois o Pi retém esses metadados para fazer a
  chamada real.

O schema confirma que `ServerProviderModel` só tem os campos acima
(`packages/contracts/src/server.ts:64-74`) e que `ModelCapabilities` contém
apenas descriptors `select | boolean` (`packages/contracts/src/model.ts:7-44,125-128`).

### Autenticação e modelos prontos neste host

A lista correta para a UI é a resposta de `get_available_models`, não o
catálogo estático completo nem `get_models`. O runtime chama `models.getAvailable`
e `checkAuth` ao construir o snapshot disponível
(`.../dist/core/model-runtime.js:174-196`), e o RPC devolve exatamente esse
snapshot (`.../dist/modes/rpc/rpc-mode.js:380-382`).

Com `PI_OFFLINE=1` para impedir rede nova, mas com as extensões normais
carregadas, a sessão real deste host retornou 232 modelos disponíveis:

| Provider Pi       | Modelos disponíveis |
| ----------------- | ------------------: |
| `anthropic`       |                  13 |
| `cliproxy`        |                   4 |
| `cliproxy-openai` |                   1 |
| `cursor`          |                 206 |
| `ollama`          |                   1 |
| `openai-codex`    |                   7 |

Isso inclui, por exemplo, os sete modelos Codex `gpt-5.3-codex-spark`,
`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol` e
`gpt-5.6-terra`. A lista `settings.json.enabledModels` é uma preferência de
escopo/ciclagem da TUI; não é a lista completa que o RPC anuncia.

Há uma anomalia específica neste host: `pi auth check --provider
openai-codex --json --no-refresh` retornou
`{"status":"invalid","provider":"openai-codex","reason":"invalid_state"}`.
O diagnóstico direto aponta que o `auth.json` contém também um registro
`telegram` com `{botToken,chatId}`, que a versão atual do armazenamento de
credenciais rejeita como credencial Pi (`Invalid auth.json credential for
provider "telegram"`). Portanto, o subcomando `pi auth check` não é confiável
neste estado e não deve ser usado sozinho para filtrar a UI. A própria sessão
RPC consegue iniciar com o OAuth Codex, a chave da extensão Cursor e as
configurações/env dos providers customizados, e sua lista disponível é a
evidência operacional usada acima. Corrigir o registro Telegram é uma tarefa
separada e está fora deste ticket.

### Comandos e testes executados

- `pi --version` → `0.84.1`.
- `pi --help`, `pi auth --help`, `pi update --help`.
- Inspeção somente leitura de `/home/vinicius/.pi/agent/models.json`,
  `models-store.json`, `settings.json` e metadados de `auth.json` (sem exibir
  segredos).
- `PI_OFFLINE=1 pi --list-models` → catálogo local por provider.
- Processo RPC descartável com `get_state`, `get_available_models`,
  `get_available_thinking_levels`, `set_model` e `set_thinking_level` → todos
  os comandos de modelo/thinking retornaram sucesso.
- Inspeção do código instalado do Pi e do contrato T3; nenhum teste do repo foi
  necessário porque este ticket só documenta findings e não altera código de
  produção.

### Bloqueios

Não há bloqueio para o desenho do catálogo/driver: o RPC cobre descoberta,
troca de modelo e thinking. Existe apenas a anomalia operacional documentada
acima: `pi auth check` fica em `invalid_state` por causa da entrada `telegram`
incompatível no `auth.json`; o snapshot RPC continua sendo a fonte observada
para os modelos disponíveis.
