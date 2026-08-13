# Mapa: T3 Code com Pi

Labels: `wayfinder:map`

## Destino

O Pi rodando dentro do T3 neste computador — usando o binário, a configuração e
as extensões de `~/.pi/agent` — com o APK de desenvolvimento do `apps/mobile`
conectado ao host por LAN/Tailscale, conversando com o Pi principal (extensões e
subagentes ativos, imagens entrando pelo pipeline de anexos do T3).

O momento de aceitação: **mensagem enviada do celular na LAN, Pi trabalhando com
suas extensões e subagentes, resultado voltando na thread.**

Escopo aprovado completo: [`t3-com-pi-scope.md`](../../t3-com-pi-scope.md).

## Notas

**Este mapa carrega execução.** O destino é a integração funcionando, não um
spec — os tickets vão além de decidir e chegam a construir. Ainda assim, cada
ticket resolve _uma_ coisa; nenhum ticket é "implementar a integração".

**Domínio:** monorepo pnpm do T3 Code (Effect-TS). O ponto de entrada da
integração é a SPI `ProviderDriver` em `apps/server/src/provider/` — um driver
produz `snapshot` / `adapter` / `textGeneration`. `ProviderDriverKind` vive em
`@t3tools/contracts` e é um tipo fechado, então um provider novo atravessa
server + contracts + clients. Vocabulário do repo em `AGENTS.md`.

**Skills a consultar em toda sessão:** `/grilling` e `/domain-modeling` (padrão),
`/research` para tickets AFK, `/prototype` para spikes, `/tdd` ao implementar.

**Preferências fixadas desta iniciativa:**

- **Fork rebaseável.** Minimizar o diff contra `upstream/main`: preferir arquivos
  novos e pontos de extensão; tocar arquivos existentes só quando não houver
  alternativa razoável.
- **Testes no padrão do repo.** Adapters existentes têm suíte em par com a
  implementação (`ClaudeAdapter.ts` 4.6k linhas / `.test.ts` 4.4k). A integração
  Pi segue essa convenção — o código deve ser contribuível upstream.
- **Modelos espelhados.** O T3 lista os modelos que o Pi conhece e repassa a
  escolha via RPC (em vez de uma entrada única "Pi").
- **Providers nativos ficam.** Claude/Codex/Cursor/Grok/OpenCode continuam
  registrados e intocados; o Pi entra ao lado deles. Não usá-los é escolha de
  configuração, não de código.
- **Isolamento é requisito, não higiene.** O T3 vanilla roda ao mesmo tempo que
  este: T3 home, porta, estado e pareamento mobile precisam ser separados.
- **Idioma:** mapa, tickets e conversa em português.

**Tensão conhecida a vigiar** _(atualizada — em grande parte desarmada)_: "fork
rebaseável" parecia puxar contra "modelos espelhados". Verificado no código: os
modelos do T3 são **dados, não enum** — `ServerProviderModel` é um Struct e o
snapshot do provider carrega `models: Array(...)`; o Cursor já descobre o
catálogo dinamicamente via ACP, e o nível de esforço cabe em
`ModelCapabilities.optionDescriptors` como um `select`. Espelhar o Pi, portanto,
**não exige tocar contracts**. O que continua atravessando contracts e clients é
o `ProviderDriverKind` novo — o veredito sobre rebaseabilidade agora depende só
de `04`. Detalhes e ponteiros de código no ticket `12`.

## Decisões até aqui

<!-- índice: uma linha por ticket resolvido — o detalhe vive no ticket -->

- **05 — ambiente T3 isolado:** `--home-dir`/`T3CODE_HOME` separa
  `<base>/userdata`; `T3CODE_PORT_OFFSET` + `--port` separa web/backend;
  pairing usa `t3 pair --base-dir`. Prova simultânea em `14273`/`6233` contra
  vanilla em `3773`, com bancos e `environmentId` distintos. Detalhes:
  [`05-ambiente-t3-isolado.md`](issues/05-ambiente-t3-isolado.md).
- **Topologia de processo e ciclo de vida do Pi:** uma sessão Pi persistente e
  exclusiva por thread T3; o processo é criado sob demanda, reaproveitado
  enquanto ativo e encerrado após inatividade. Detalhes:
  [`08-topologia-de-processo.md`](issues/08-topologia-de-processo.md).
- **Continuidade: thread T3 × sessão Pi:** vínculo estável 1:1 em namespace
  isolado; T3 guarda a thread visível, Pi guarda seu contexto, e falhas de
  retomada no MVP são explícitas, sem reconstrução automática. Detalhes:
  [`09-continuidade-de-sessao.md`](issues/09-continuidade-de-sessao.md).

## Ainda não especificado

Névoa dentro do escopo — visível, ainda não afiada o bastante para virar ticket:

- **Fatiamento da implementação do driver + adapter Pi.** Topologia e
  continuidade estão decididas; só ganha forma depois de `10` fechar o
  mapeamento de eventos. Provavelmente vira vários tickets de execução.
- **Estratégia concreta de teste do adapter.** O que fixturar, quais transcripts
  de RPC gravar, onde ficam os test doubles do processo Pi. Depende de `01` e
  `10`.
- **Imagens até o Pi.** Depende de `01` responder se e como o RPC aceita
  conteúdo binário/MIME. Se aceitar, vira ticket de mapeamento do pipeline de
  anexos; se não aceitar, vira decisão sobre erro de backend.
- **MCP nativo do T3 apenas para o Pi principal.** Depende de `02`.
- **Subagentes sob o transporte do T3.** Como `subagent_spawn`/`wait`/`cancel`/
  `check`/`list` e seus resultados atravessam o adapter sem virar UI própria.
  Depende de `10`.
- **Modo `full-access` e aprovações.** O escopo diz para não adaptar aprovações;
  falta confirmar que o Pi nunca fica bloqueado esperando uma. Depende de `01`.

## Fora de escopo

Ruled out desta iniciativa — não é névoa, não gradua. Corresponde ao backlog do
escopo aprovado:

- UI própria do Pi no T3 (FleetView, takeover, dashboard, transcript dedicado).
- Gerenciamento individual de subagentes pelo mobile; threads T3 filhas para
  subagentes; subagentes com MCP do T3.
- MCPs externos configurados pelo usuário.
- Descoberta/autocomplete/catálogo de slash commands do Pi.
- Geração e edição de imagens.
- Múltiplos usuários, múltiplos hosts, alta concorrência.
- Suporte garantido a extensões frontend do Pi.
- Atualização automática, empacotamento ou matriz de versões do Pi.
- T3 Connect, relay ou qualquer serviço hospedado no caminho do mobile.
