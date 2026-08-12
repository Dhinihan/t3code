# Espelhar os modelos do Pi sem quebrar a rebaseabilidade

Type: grilling
Status: open
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
