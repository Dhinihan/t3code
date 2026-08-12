# Anatomia de um driver T3 e a pegada de um `ProviderDriverKind` novo

Type: research
Status: resolved
Blocked by: —

## Pergunta

Qual é o **menor** conjunto de arquivos que precisa existir ou mudar para que um
provider novo apareça no T3 e funcione ponta a ponta? A resposta define se o
"fork rebaseável" sobrevive ao contato com a realidade.

Usar os drivers menores como referência (OpenCode e Grok, não o Claude), e
mapear:

- **Server:** o que um `ProviderDriver` precisa entregar — `snapshot`, `adapter`,
  `textGeneration` — e o tamanho real de cada peça. Como `ProviderInstanceRegistry`,
  `ProviderService` e o reaper de sessões esperam ser tratados.
- **Contracts:** `ProviderDriverKind` é um tipo fechado em `@t3tools/contracts`.
  Enumerar tudo que quebra ou exige extensão ao acrescentar um kind — schemas,
  unions exaustivas, `switch` sem default.
- **Clients:** o que web / desktop / mobile assumem por provider — ícones, cores,
  telas de settings, seletor de modelo, strings. Quais são obrigatórios para o
  provider funcionar e quais são só polimento.
- **Pegada do diff:** classificar cada ponto de toque em (a) arquivo novo,
  (b) uma linha em uma lista (como `BUILT_IN_DRIVERS`), (c) edição invasiva em
  arquivo que o upstream mexe com frequência. Consultar o histórico do git para
  saber quais desses arquivos são quentes no upstream.
- **Existe ponto de extensão?** O diretório `acp/` e `packages/effect-acp`
  sugerem um caminho genérico de protocolo. Um driver ACP-shaped reduziria o diff
  — e o Pi conseguiria falar isso?

Entregar como documento de findings no repo: a lista de arquivos, classificada
por invasividade, e um veredito sobre a viabilidade do fork rebaseável.

## Answer

### Veredito curto

O menor caminho rebaseável é registrar um driver novo como uma instância
explícita de `providerInstances`, sem criar uma chave nova no legado
`settings.providers`:

1. adicionar um `ProviderDriver` novo e as peças específicas do protocolo
   (adapter, snapshot/probe e text generation);
2. adicionar o driver à lista `BUILT_IN_DRIVERS`;
3. expor uma definição no web somente se ele precisar ser criado/configurado
   pela tela de Settings;
4. reutilizar os registries, o `ProviderService`, o reaper, os contratos de
   instância e o caminho ACP genérico.

O `ProviderDriverKind` não é fechado hoje. Ele é um slug branded aberto, com
validação de formato, e a disponibilidade é decidida pelo registry. Portanto,
um fork pode usar, por exemplo, `pi-agent`, sem editar uma union central. A
pergunta original parte de uma premissa que o código atual já superou.

### Evidência do contrato e do runtime

`packages/contracts/src/providerInstance.ts:16-28,59-75` documenta e define
`ProviderDriverKind` como slug aberto (inclusive citando drivers de fork como
`ollama`). `ProviderInstanceConfig` em `:106-140` mantém `config` como
`Schema.Unknown`, além de preservar driver/config desconhecidos. Os testes em
`packages/contracts/src/providerInstance.test.ts:18-31,69-75,154-199` e em
`packages/contracts/src/settings.test.ts:127-159,225-236` comprovam que
drivers de fork podem ser decodificados, misturados com os first-party e
round-tripados sem alteração no contrato.

O SPI real está em `apps/server/src/provider/ProviderDriver.ts:38-169`:

- metadata: `driverKind`, `displayName` e `supportsMultipleInstances`;
- `configSchema` e `defaultConfig`;
- `create(input)`, que precisa devolver um `ProviderInstance` com
  `snapshot`, `adapter` e `textGeneration`;
- o `create` recebe um `Scope`, então o processo/recursos do provider devem
  ser liberados pelo lifecycle da instância.

O adapter não é opcional. `apps/server/src/provider/Services/ProviderAdapter.ts:26-125`
define a superfície de sessão: start/send/interrupt/respond/stop, listagem e
leitura de threads, rollback, `stopAll` e `streamEvents`. Operações sem suporte
devem usar o erro/capability apropriado, não um método omitido. O snapshot é o
shape genérico de `apps/server/src/provider/Services/ServerProvider.ts:6-11`;
`makeManagedServerProvider.ts` já concentra refresh, enrichment e lifecycle.

Como referência concreta, `GrokDriver.ts` tem 163 linhas e
`OpenCodeDriver.ts` 194, mas eles apenas montam as peças. O tamanho efetivo
dos providers atuais, medido no checkout, é:

| Peça                   |                   Grok | OpenCode | Classificação                          |
| ---------------------- | ---------------------: | -------: | -------------------------------------- |
| Driver                 |                    163 |      194 | arquivo novo, fino                     |
| Adapter                |                   1464 |     1721 | arquivo novo, grande; protocolo/sessão |
| Provider/probe         |                    335 |      454 | arquivo novo                           |
| Text generation        |                    260 |      624 | arquivo novo; obrigatório pelo SPI     |
| suporte ACP específico | 108 + extensão XAI 432 |        — | só se o protocolo exigir               |
| runtime específico     |                      — |      756 | necessário para SDK/HTTP próprio       |

O driver usa `makeManagedServerProvider`, `makeGrokTextGeneration` ou
`makeOpenCodeTextGeneration` e registra as dependências no environment do
driver. Isso é a menor forma segura de manter a complexidade na fronteira do
adapter.

### Arquivos e invasividade

#### Obrigatórios para um driver first-party funcional

| Peça                           | Arquivo/alteração                                                                                         | Invasividade                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Driver                         | novo `apps/server/src/provider/Drivers/PiDriver.ts`                                                       | baixa; isolado                                |
| Adapter e serviços do provider | novos arquivos sob `apps/server/src/provider/Services/` e/ou `apps/server/src/provider/Drivers/`          | média; a maior parte do trabalho de protocolo |
| Snapshot/probe                 | novo módulo de provider, conectado a `makeManagedServerProvider`                                          | baixa/média                                   |
| Text generation                | novo `PiTextGeneration.ts`, ou implementação deliberadamente unsupported do serviço genérico              | baixa no core, média no provider              |
| Registro                       | `apps/server/src/provider/builtInDrivers.ts:1-53`: import, membro da union de environment e item no array | baixa; poucas linhas                          |

`ProviderInstanceRegistryHydration.ts:44-104,152-174` já sintetiza instâncias
legadas e hidrata o mapa explícito. `ProviderInstanceRegistryLive.ts:104-205`
já faz lookup por kind, decode de config, cria child scope, anexa finalizer e
produz unavailable shadow snapshot para driver desconhecido. O reconcile em
`:211-311` fecha scopes antes de substituir/remover instâncias. Não há switch
por provider novo para editar nesses arquivos.

`ProviderAdapterRegistry.ts:1-117` é lookup dinâmico por instance id;
`ProviderService.ts:303-340` assina `streamEvents` para cada adapter presente e
encaminha as operações para o adapter; `ProviderSessionReaper.ts:25-152`
varre bindings genericamente e chama `stopSession`. Logo, nenhum dos três
precisa de uma entrada Pi. `ProviderRegistry.ts` também agrega snapshots por
instância sem lista fixa; a única exceção atual é a retenção especial de
modelos incompletos para `opencode` (`:81-96`). Pi só deve tocar esse arquivo
se tiver a mesma semântica de inventário parcial.

`apps/server/src/server.ts:363-413` só precisa mudar se Pi introduzir uma
dependência Effect nova que ainda não exista no environment. Um driver ACP
que use as camadas existentes não requer nova camada no servidor.

#### Contratos e defaults: opcionais, dependendo do produto desejado

- `packages/contracts/src/providerInstance.ts` e
  `packages/contracts/src/server.ts:46-74,161-205`: nenhuma alteração para o
  caminho genérico. `ServerProvider` e `ServerProviders` já transportam kind,
  instance, status, modelos e indisponibilidade de forma forward-compatible.
- `packages/contracts/src/settings.ts:592-612`: só alterar se Pi for uma
  chave first-class de `ServerSettings.providers`. Esse caminho exige schema,
  patch, defaults e migração; é mais invasivo e toca um arquivo quente.
  Com `providerInstances`, o mapa genérico e config opaca já bastam.
- `packages/contracts/src/model.ts:130-225`: as tabelas de display name,
  default model e aliases são `Partial<Record<ProviderDriverKind,...>>`, então
  não quebram compilação. Adicionar Pi melhora label/default/aliases, mas não é
  requisito se o snapshot fornece modelos.
- `apps/server/src/serverSettings.ts:185-205`: o fallback automático para
  text-generation ainda varre apenas providers legados. Pi precisa ser
  incluído ali, ou ter seleção explícita de instância, se deve virar fallback
  automático.
- `apps/server/src/textGeneration/TextGeneration.ts:11` mantém um alias
  fechado `TextGenerationProvider = "codex" | ...`; o `rg` do checkout não
  encontrou uso operacional desse alias. É uma dívida de tipagem: só editar se
  ele passar a ser usado para representar o novo kind; o SPI de
  `TextGeneration.Service` já é genérico.
- `packages/contracts/src/providerRuntime.ts:21-31`: ACP pode usar
  `acp.jsonrpc` e `acp.${string}.extension` já previstos. Um runtime Pi não-ACP
  que invente uma nova fonte raw de eventos precisará estender essa union.

#### Clients

| Superfície | Obrigatório para funcionar                                                                                                                | Polimento/first-party                                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web        | Nenhum arquivo se a instância vier pré-configurada e o snapshot for válido; `providerInstances.ts` e `providerModels.ts` já são genéricos | `apps/web/src/components/settings/providerDriverMeta.ts:37-90` para aparecer no Add Provider; `session-logic.ts:28-51` para o picker legado; `providerIconUtils.ts:5-22` para ícone; maps em `packages/contracts/src/model.ts` para label/default |
| Desktop    | Nenhum registro adicional: o desktop envolve o web e usa o mesmo server/runtime                                                           | apenas assets/UX herdados do web                                                                                                                                                                                                                  |
| Mobile     | `modelOptions.ts:30-39,107-168` já itera providers/instâncias do servidor                                                                 | `apps/mobile/src/components/ProviderIcon.tsx:25-69` adiciona ícone; `ThreadSettingsSheet.tsx:37-42,349-378,508-535` trata Pi como provider primário se essa hierarquia for desejada                                                               |

No web, `AddProviderInstanceDialog.tsx:65-101,134-215,264-300` grava
configuração genérica; o driver só não aparece na lista até existir uma entrada
em `providerDriverMeta.ts`. Um fork pode começar com configuração seedada para
evitar mexer no picker legado. Providers desconhecidos já têm fallback de
iniciais em `ProviderInstanceIcon.tsx:17-51`.

No mobile, label sem `displayName` pode cair para o instance id e provider sem
ícone cai no ícone fallback. Isso é defeito de apresentação, não bloqueio de
routing/model selection. Não foi encontrado registro específico adicional em
`apps/desktop`.

### ACP e a escolha entre Grok e OpenCode

O caminho de Grok é o modelo mais próximo para Pi: `GrokAcpSupport.ts` monta
comando/argumentos e sessão e `GrokAdapter.ts` usa `AcpSessionRuntime.ts`.
`AcpSessionRuntime.ts:53-79,99-247` já abstrai stdio, resume/load, prompt,
cancel, update, permission, model/config e handlers de extensão. O suporte
comum de erro está em `AcpAdapterSupport.ts:17-56`, e `packages/effect-acp`
fornece client/protocol/schema.

Isso reduz o diff somente se o Pi realmente falar ACP sobre stdio e implementar
as capacidades necessárias: initialize, authenticate quando aplicável,
session/new/load/resume, prompt, cancel, updates e permission; model/config são
necessários para a experiência completa. A extensão `XAiAcpExtension` do Grok
não deve ser copiada automaticamente: só é necessária se Pi declarar uma
extensão equivalente. Se Pi falar um JSON-RPC próprio ou tiver um CLI sem ACP,
o pacote não é um adaptador mágico; será necessário um runtime/adapter Pi e
eventuais novos mapeamentos de eventos.

OpenCode é uma referência de SPI, mas não de protocolo: usa
`OpenCodeRuntime.ts` e adapter/SDK HTTP próprio, não `AcpSessionRuntime`. Para
Pi, Grok é a referência de menor acoplamento ao core; OpenCode serve para
comparar o caso em que um runtime próprio é inevitável.

### Histórico e arquivos quentes

Contagem de commits com `git log --follow` no checkout e último commit observado:

| Arquivo                                | Commits | Última alteração         | Calor                             |
| -------------------------------------- | ------: | ------------------------ | --------------------------------- |
| `ProviderDriver.ts`                    |       4 | `b6302784f` (2026-06-19) | baixo                             |
| `builtInDrivers.ts`                    |       2 | `38ea6d483` (2026-06-09) | baixo                             |
| `ProviderInstanceRegistryHydration.ts` |       3 | `9a1c4875a` (2026-06-20) | baixo                             |
| `ProviderInstanceRegistryLive.ts`      |       2 | `25b02f4ba` (2026-05-08) | baixo                             |
| `ProviderRegistry.ts`                  |      13 | `4e09cddb4` (2026-07-22) | médio; já contém exceção OpenCode |
| `ProviderService.ts`                   |      53 | `a6c9b41f9` (2026-08-08) | alto                              |
| `apps/server/src/server.ts`            |      64 | `f5fce7416` (2026-08-11) | muito alto                        |
| `packages/contracts/src/settings.ts`   |      49 | `6dbffa022` (2026-08-08) | alto                              |
| `packages/contracts/src/model.ts`      |      45 | `d7950ac15` (2026-08-04) | alto                              |
| `apps/web/src/session-logic.ts`        |      72 | `a8cd2ad2e` (2026-08-07) | muito alto                        |
| `providerDriverMeta.ts`                |       4 | `38ea6d483` (2026-06-09) | baixo                             |
| mobile `ProviderIcon.tsx`              |       3 | `94331c58e` (2026-08-04) | baixo                             |
| `AcpSessionRuntime.ts`                 |      10 | `bcd640bf4` (2026-07-18) | médio, mas genérico               |

O commit histórico `38ea6d483` (`feat(grok): add Grok CLI provider via ACP`)
alterou 40 arquivos e adicionou 3673 linhas; mesmo isolando o provider, houve
centenas de linhas em adapter/probe/ACP/text-generation e pequenas alterações
em contracts, registry, web e ícones. Isso é o limite superior real de um
provider first-party completo, não o tamanho do SPI atual.

### Veredito sobre o fork rebaseável

**Sim, é rebaseável**, desde que Pi seja implementado como uma ilha de novos
arquivos, com apenas a entrada de `builtInDrivers.ts` e, se necessário, uma
entrada curta em `providerDriverMeta.ts`. O caminho recomendado é:

- configurar uma instância explícita em `providerInstances`;
- usar `ProviderDriverKind` como slug novo, sem alterar a união central;
- reutilizar ACP se Pi for ACP-shaped;
- deixar snapshot e adapter alimentarem os registries genéricos;
- adiar legacy settings, picker antigo, fallback automático e ícones até haver
  uma necessidade de produto.

O fork perde parte dessa propriedade se Pi exigir edição de `server.ts`,
`ProviderService.ts`, `settings.ts`, `session-logic.ts` ou uma nova exceção em
`ProviderRegistry.ts`; todos são arquivos quentes ou semânticos. Portanto, a
classificação final é: **runtime mínimo: invasividade baixa/média e altamente
rebaseável; integração first-class em todas as telas/configurações: média/alta
e sensível ao upstream**.

### Comandos, testes e bloqueios

Comandos de investigação principais: `rg -n` nos contratos, registries,
drivers e clients; `wc -l` para comparar Grok/OpenCode; `git log --follow` por
arquivo; `git show --stat 38ea6d483` para a adição histórica do Grok.

Teste focado executado:

```text
pnpm exec vp test run packages/contracts/src/providerInstance.test.ts packages/contracts/src/settings.test.ts apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts
```

Resultado: **3 arquivos, 79 testes aprovados**. O comando `vp` direto não está
no PATH desta sessão; o binário via `pnpm exec` funcionou.

Não há bloqueio para este research e nenhum provider foi implementado. O único
limite factual é que não existe neste checkout uma implementação/documentação
do Pi para confirmar quais métodos ACP e extensões ele suporta; a conclusão de
compatibilidade ACP é, portanto, condicional ao protocolo real do Pi.
