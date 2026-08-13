# Papel do Pi no serviço auxiliar de text generation

Type: grilling
Status: resolved
Blocked by: —

## Pergunta

O SPI `ProviderDriver` exige `textGeneration`, usado por funções auxiliares do
T3 além do turno principal. Decidir qual comportamento o driver Pi deve
oferecer no MVP sem ampliar silenciosamente a topologia escolhida:

- usar processos Pi efêmeros e um modelo scoped/default para essas chamadas;
- reutilizar alguma sessão existente sem contaminar o contexto da thread;
- delegar explicitamente a outro provider configurado do T3;
- ou declarar o serviço não suportado e manter a seleção auxiliar fora do Pi.

A resposta deve fixar modelo/seleção, isolamento de sessão, lifecycle, custo de
spawn, tratamento de erro e quais fluxos do produto precisam continuar
funcionando para alcançar o destino do mapa.

## Answer

**O driver Pi declara o serviço auxiliar não suportado.** O slot
`textGeneration` existe, é tipado e falha explícito. Nenhum processo Pi é criado
por geração auxiliar. Text generation via Pi de verdade sai de escopo desta
iniciativa.

### Fatos que sustentam a decisão

**O despacho é por instância, não por thread.** `makeTextGenerationFromRegistry`
resolve pelo `input.modelSelection.instanceId`
(`apps/server/src/textGeneration/TextGeneration.ts:166`). O `textGeneration` do
driver Pi **nunca** é chamado porque a thread é Pi — só se a instância Pi for a
selecionada no setting global. O caminho de aceitação do mapa (mensagem do
celular → Pi trabalha → resposta na thread) não passa por aqui.

**As quatro operações e a visibilidade da falha:**

| operação                | disparo                                                | falha aparece?                    |
| ----------------------- | ------------------------------------------------------ | --------------------------------- |
| `generateThreadTitle`   | automático, 1º turno (`ProviderCommandReactor.ts:869`) | não — `catchCause` → `logWarning` |
| `generateBranchName`    | automático, worktree temporária (`:824`)               | não — `catchCause` → `logWarning` |
| `generateCommitMessage` | ação do usuário, web                                   | sim                               |
| `generatePrContent`     | ação do usuário, web                                   | sim                               |

**A degradação real das automáticas é mínima.** O cliente já grava o título como
o primeiro turno truncado (`apps/mobile/src/lib/projectThreadStartTurn.ts:61`,
`apps/web/src/components/ChatView.tsx:5167`); o text generation apenas o
_substitui_ depois, quando `canReplaceThreadTitle` permite
(`ProviderCommandReactor.ts:230`). Falhar deixa a thread com a mensagem
truncada, não com `"New thread"`. Por isso **o critério de aceitação do mapa não
muda** — o ticket **Aceitação mobile Pi ponta a ponta** segue válido como está.

**O Pi pode ser selecionado sem intenção.** `resolveAppModelSelectionState`
(`apps/web/src/modelSelection.ts:290`) cai para a primeira instância
enabled+available quando a selecionada não está disponível. Com os providers
nativos desabilitados, o web aponta text generation para o Pi sozinho — e o
usuário vê o erro sem ter escolhido nada. Daí a exigência de mensagem acionável
(abaixo). No server, `fallbackTextGenerationProvider`
(`apps/server/src/serverSettings.ts:191`) varre `settings.providers` — chaves
legacy — então numa configuração Pi-only ele não acha fallback e deixa a seleção
apontando para instância não registrada, produzindo
`No provider instance registered`. **Comportamento vanilla, não tocado.**

**Custo de spawn — medido no `pi` 0.84.1 instalado**, `--mode rpc --no-session`,
cwd `/tmp`:

- spawn → resposta de `get_state`: **2,56 s** (as extensões carregam também no
  efêmero — `extension_ui_request` de `setStatus`/cursor chega antes do
  `get_state`);
- prompt trivial → `agent_settled`: **+2,3 s**;
- **one-shot completo: ~4,9 s** no modelo default `gpt-5.6-sol`.

O número não era proibitivo — a decisão é de escopo, não de custo. Fica
registrado porque é o dado que uma retomada futura precisa. Fatos adjacentes
confirmados no mesmo teste: o envelope de evento é **plano** (`{"type":
"agent_start"}`), não embrulhado; a forma do comando é `{ id, type: "get_state" }`
(sem campo `command` na entrada).

**Precedentes se um dia isto voltar:** Cursor usa processo efêmero por chamada
(`CursorTextGeneration.ts`, 268 linhas + 276 de teste, timeout 180 s,
`setMode("ask")`); OpenCode usa server compartilhado com sessão descartável e
idle TTL de 30 s (624 linhas). O Pi tem as ferramentas para o padrão Cursor:
`--no-session`, `--tools`/`--exclude-tools`, `--model`/`--provider`/`--thinking`
e `get_last_assistant_text`.

### O que fica decidido

1. **Não suportado, falha imediata.** As quatro operações falham com
   `TextGenerationError` **sem criar processo Pi** — custo zero e
   determinístico. Tentar e falhar só queimaria os 2,5 s de spawn para chegar ao
   mesmo lugar.
2. **Uma mensagem, não quatro.** O `operation` já vem no campo estruturado do
   erro; o `detail` é único e acionável, apontando a saída ao usuário — na linha
   de _"O provider Pi não oferece geração auxiliar de texto. Escolha outro
   provider em Settings → Text generation."_ Sem "MVP"/"ainda não" na string:
   mensagem de produto não é datada.
3. **Pegada zero na UI e em contracts.** Nada de entrada nova em
   `DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER`
   (`packages/contracts/src/model.ts:159`), nada de filtro novo no picker do
   web. O Pi aparece no picker pelo caminho genérico e o modelo default sai do
   fallback `entry.models[0]?.slug` que `resolveAppModelSelectionState` já usa.
   Se o primeiro modelo do catálogo se mostrar ruim depois, é uma linha — e volta
   como ticket próprio.
4. **Arquivo próprio:** `apps/server/src/textGeneration/PiTextGeneration.ts` com
   `PiTextGeneration.test.ts` par, seguindo os cinco existentes. Arquivo novo,
   zero conflito de rebase, e é onde qualquer um procura. Se um dia o Pi gerar de
   verdade, a implementação nasce no lugar certo em vez de ser extraída do
   driver.
5. **Restrição documentada:** manter ao menos um provider nativo habilitado para
   geração auxiliar. Pi-only continua funcionando para o turno principal — que é
   o destino do mapa.

### Suíte

Cinco casos em `PiTextGeneration.test.ts`: cada uma das quatro operações falha
com `TextGenerationError` carregando o `operation` correto, mais um caso
provando que **nenhum processo Pi é criado** (spawner de teste sem invocações).

### Fora de escopo daqui

Fazer o Pi gerar títulos, nomes de branch, commits e PRs. O destino do mapa não
passa por isso, então não é névoa — não gradua. Volta como esforço novo se o
destino for redesenhado.
