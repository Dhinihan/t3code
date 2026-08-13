# Espelhar os modelos do Pi sem quebrar a rebaseabilidade

Type: grilling
Status: resolved
Blocked by: 03, 04

## Precedente já levantado: o Cursor faz exatamente isto

Verificado no código antes deste ticket existir — **a tensão original está em
grande parte desarmada**. Modelos são _dados_, não um enum:
`ServerProviderModel` é um Struct (`packages/contracts/src/server.ts:64`) e o
snapshot do provider carrega `models: Array(ServerProviderModel)` (`:190`). Não
há union fechada de modelos em contracts.

O padrão Cursor, a copiar:

- **Descoberta dinâmica:** `discoverCursorModelsViaListAvailableModels` faz
  `acp.request("cursor/list_available_models", {})`, decodifica e mapeia para
  `ServerProviderModel` com dedupe por slug
  (`CursorProvider.ts:553` e `:381`), com timeout de 15s.
- **Snapshot em dois tempos:** `buildInitialCursorProviderSnapshot` publica na
  hora com fallback (`getCursorFallbackModels` = só os `customModels` das
  settings) e status "checking"; a lista real substitui depois. Falha vira
  `CURSOR_ACP_MODEL_DISCOVERY_FAILED_MESSAGE`, não tela quebrada.
- **Esforço é option descriptor:** `ModelCapabilities` é só
  `{optionDescriptors?: ProviderOptionDescriptor[]}` (`contracts/src/model.ts:125`),
  uma union `select | boolean` (`:7-44`). O Cursor deriva os seus dos
  `configOptions` por modelo (context / fast / thinking). O `--thinking` do Pi
  (off…max) encaixa como um `select` — sem schema novo.
- **Merge de custom models:** todos os providers passam por
  `providerModelsFromSettings(builtIns, customModels, caps)`.

Contraste: Claude e Codex são estáticos (`BUILT_IN_MODELS` de
`CLAUDE_MODEL_CATALOG`) — o Pi não deve seguir esses.

## Pergunta

Restou decidir a forma concreta, não mais se é viável:

- O Pi consegue entregar catálogo **sob demanda pelo RPC** (como o Cursor faz por
  ACP), ou o T3 vai ter que ler `~/.pi/agent/models.json` do disco? A segunda
  opção acopla a integração ao layout de arquivos do Pi — o que o escopo evita.
  `03` traz o fato.
- Qual é o fallback do snapshot inicial, já que o Pi não tem `customModels` nas
  settings do T3 — lista vazia, ou um único modelo genérico até a descoberta
  responder.
- Se a lista é revalidada, e o que acontece quando o usuário roda `pi update` e o
  catálogo muda debaixo de uma lista já espelhada.
- Filtrar por modelos autenticados/prontos (`pi auth`), ou mostrar tudo e falhar
  na hora do uso.
- Quais `optionDescriptors` o Pi expõe além de thinking, e se a troca vale por
  turno ou só na abertura da sessão (`03` responde se dá para trocar em sessão
  viva).
- **O que sobrou da tensão:** o catálogo saiu do caminho, mas o
  `ProviderDriverKind` novo continua atravessando contracts e clients. O veredito
  sobre rebaseabilidade migra para `04`; se lá também não houver custo alto, a
  tensão registrada no mapa pode ser encerrada.

## Answer

### Decisão

O snapshot Pi seguirá o padrão dinâmico do Cursor: publica imediatamente um
estado `checking` com `models: []`, depois sobe um processo
`pi --mode rpc` descartável e usa a mesma conexão para o handshake sintético de
`11` (`get_state`) e para a descoberta do catálogo. A cadência permanece a
padrão do T3, cinco minutos; o MVP não introduz intervalo especial nem cache
adicional para o Pi.

O catálogo exibido será o **escopo de modelos Pi**, não a lista inteira de
modelos autenticados. “Escopo de modelos Pi” é a lista já resolvida pelo próprio
Pi a partir de `--models` ou `settings.json.enabledModels`, preservando ordem e
um thinking eventualmente fixado no padrão. Neste host isso reduz a UI de 232
modelos disponíveis para 11 modelos escolhidos pelo usuário.

### Como obter o escopo sem ler configuração do Pi

O RPC `get_available_models` e a CLI `pi --list-models` ignoram o escopo e
retornam `modelRuntime.getAvailableSnapshot()`. O protocolo também não oferece
`get_scoped_models`. Ler `~/.pi/agent/settings.json` e reimplementar o matching
de patterns foi descartado porque duplicaria uma regra interna do Pi e acoplaria
o T3 ao formato da configuração.

O probe carregará por `--extension` uma **extensão-ponte interna do T3**, mantida
como arquivo novo da integração. Essa extensão registra um comando reservado que
serializa `ctx.scopedModels`, API oficial e read-only de extensões do Pi. O T3
invoca o comando via `prompt` RPC, correlaciona a resposta
`extension_ui_request` por identidade própria da operação e encerra o processo.
A extensão não é instalada nem escrita em `~/.pi/agent`; é carregada apenas no
processo descartável e convive com as extensões pessoais já descobertas pelo Pi.

Uma prova descartável nesta sessão carregou a extensão por `--extension`,
executou o comando por RPC e recebeu exatamente os 11 modelos de
`enabledModels` deste host. A enumeração alternativa por `cycle_model` foi
rejeitada: embora respeite o escopo, cada ciclo chama
`setDefaultModelAndProvider` e persiste efeitos em `settings.json`.

Quando `ctx.scopedModels` vier vazio, isso significa **escopo não configurado**,
não catálogo vazio. Nesse caso o snapshot cai para `get_available_models`,
preservando a semântica do Pi de que todos os modelos disponíveis podem ser
usados. Não haverá allowlist/denylist adicional na configuração do driver.
Também não haverá filtro de autenticação separado: `get_available_models` já é
a visão pós-`checkAuth` do runtime, e `pi auth check` não é uma fonte confiável
neste host, conforme `03`.

### Mapeamento para a UI do T3

Cada entrada usa slug canônico `provider/modelId`, nome do Pi, `subProvider`
igual ao provider Pi e `isCustom: false`, pois a origem custom não é distinguível
pelo RPC. O snapshot não exige alteração em contracts.

A única opção do MVP é `thinking`, representada como descriptor `select`. As
opções são derivadas das capacidades reais do modelo e usam os nomes Pi
`off`, `minimal`, `low`, `medium`, `high`, `xhigh` e `max`. Se o padrão scoped
fixar um nível — por exemplo `anthropic/*:high` — esse nível vira o
`currentValue` inicial do descriptor, mas continua editável: no Pi ele é uma
preferência ao entrar no modelo, não uma restrição permanente.

O adapter declara `sessionModelSwitch: "in-session"`. Antes do prompt, uma
seleção diferente é aplicada com `set_model { provider, modelId }` e
`set_thinking_level`; o T3 pode trocar ambos por turno sem reiniciar a sessão.
Nenhum outro campo Pi (`cost`, `contextWindow`, `compat`, transporte) ganha opção
no MVP.

### Revalidação e catálogo obsoleto

O probe periódico refaz handshake e catálogo. Se uma seleção previamente
publicada desaparecer após `pi update` ou alteração de configuração,
`set_model` falha explicitamente com erro de backend tipado; não há fallback
silencioso para o modelo corrente e não há retry do turno. A falha também
solicita refresh imediato do snapshot para retirar a opção obsoleta da UI.

### Rebaseabilidade

A tensão “fork rebaseável × modelos espelhados” está encerrada. `04` comprovou
que `ProviderDriverKind` é um slug branded aberto, não uma union fechada, e este
ticket comprovou que catálogo e thinking cabem no snapshot genérico existente.
O desenho fica concentrado em arquivos novos — driver/runtime/extensão-ponte —
mais o registro curto em `builtInDrivers.ts`; não requer editar
`packages/contracts/src/model.ts`, `settings.ts` ou listas fechadas nos clients.
Ícone, aliases, defaults globais e presença first-class em settings continuam
polimento, não requisito do caminho funcional.
