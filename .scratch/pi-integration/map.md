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
`@t3tools/contracts`, mas é um slug branded aberto; uma instância de fork pode
usar um kind novo sem estender uma union central. Vocabulário do repo em
`AGENTS.md`.

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

**Tensão encerrada:** "fork rebaseável" não conflita com "modelos espelhados".
Modelos são dados do snapshot, `ProviderDriverKind` é um slug aberto, e o escopo
Pi pode ser descoberto por uma extensão-ponte em arquivos novos. O caminho
funcional não exige alterar contracts nem listas fechadas dos clients. Detalhes
em [`04-anatomia-do-driver-t3.md`](issues/04-anatomia-do-driver-t3.md) e
[`12-modelos-na-ui-sem-quebrar-o-rebase.md`](issues/12-modelos-na-ui-sem-quebrar-o-rebase.md).

## Decisões até aqui

<!-- índice: uma linha por ticket resolvido — o detalhe vive no ticket -->

- **05 — ambiente T3 isolado:** `--home-dir`/`T3CODE_HOME` separa
  `<base>/userdata`; `T3CODE_PORT_OFFSET` + `--port` separa web/backend;
  pairing usa `t3 pair --base-dir`. Prova simultânea em `14273`/`6233` contra
  vanilla em `3773`, com bancos e `environmentId` distintos. Detalhes:
  [`05-ambiente-t3-isolado.md`](issues/05-ambiente-t3-isolado.md).
- **06 — APK dev na LAN:** dev build Android pelo perfil EAS `development`,
  conectado ao T3 integrado pela LAN, com criação de thread real confirmada no
  celular. Detalhes: [`06-apk-dev-na-lan.md`](issues/06-apk-dev-na-lan.md).
- **Topologia de processo e ciclo de vida do Pi:** uma sessão Pi persistente e
  exclusiva por thread T3; o processo é criado sob demanda, reaproveitado
  enquanto ativo e encerrado após inatividade. Detalhes:
  [`08-topologia-de-processo.md`](issues/08-topologia-de-processo.md).
- **Continuidade: thread T3 × sessão Pi:** vínculo estável 1:1 em namespace
  isolado; T3 guarda a thread visível, Pi guarda seu contexto, e falhas de
  retomada no MVP são explícitas, sem reconstrução automática. Detalhes:
  [`09-continuidade-de-sessao.md`](issues/09-continuidade-de-sessao.md).
- **10 — eventos Pi → runtime T3:** o ciclo T3 termina em `agent_settled`;
  texto, reasoning e ferramentas usam eventos canônicos genéricos. Subagentes
  continuam sob controle do Pi como tool calls, sem `task.*`; erros locais não
  matam a sessão, input bloqueante futuro é cancelado com aviso e custo fica
  fora do MVP. Detalhes:
  [`10-mapeamento-de-eventos.md`](issues/10-mapeamento-de-eventos.md).
- **11 — handshake e incompatibilidade:** o Pi não é enumerável
  (`get_commands` são slash commands de extensão), então o critério é piso
  semver `0.84.1` + `get_state` validado por schema, na mesma função chamada
  pelo probe e pelo spawn. Probe velho vira `status: "error"` no padrão do
  OpenCode — nunca `availability: "unavailable"`, termo reservado a driver
  ausente. Decodificação tolerante: novidade se ignora, ausência derruba. Sem
  teto de versão; manutenção = atualizou o Pi, roda a suíte. Detalhes:
  [`11-handshake-e-versao.md`](issues/11-handshake-e-versao.md).
- **Suíte do adapter Pi e detecção de drift do Pi:** suíte hermética e
  contribuível em três níveis (contrato puro, runtime contra peer JSONL e
  adapter com test double); fixtures reais curadas ficam congeladas. Um probe
  manual permanente fala com o Pi instalado e detecta drift antes da suíte,
  sem alterar fixtures automaticamente. Detalhes:
  [`13-suite-do-adapter-e-drift-do-pi.md`](issues/13-suite-do-adapter-e-drift-do-pi.md).
- **Espelhar os modelos do Pi sem quebrar a rebaseabilidade:** snapshot dinâmico
  a cada cinco minutos, mostrando `ctx.scopedModels` via extensão-ponte interna
  e caindo para todos os modelos disponíveis quando não houver escopo. Slug é
  `provider/modelId`, thinking é editável por turno e catálogo obsoleto falha
  explicitamente enquanto solicita refresh. Detalhes:
  [`12-modelos-na-ui-sem-quebrar-o-rebase.md`](issues/12-modelos-na-ui-sem-quebrar-o-rebase.md).
- **Papel do Pi no serviço auxiliar de text generation:** o driver declara o
  serviço não suportado — as quatro operações falham com `TextGenerationError`
  sem criar processo Pi, com uma mensagem única e acionável. Pegada zero em
  contracts e clients; stub em `PiTextGeneration.ts` com teste par; manter um
  provider nativo habilitado para geração auxiliar é restrição documentada.
  Detalhes:
  [`20-papel-do-pi-em-text-generation.md`](issues/20-papel-do-pi-em-text-generation.md).
- **Runtime JSONL e contrato de compatibilidade do Pi:** fronteira de
  processo/protocolo em camadas, toda em arquivos novos — contrato puro
  tolerante (novidade se ignora, ausência derruba), política de compatibilidade
  compartilhada (piso `0.84.1` + `get_state`, erro tipado com mensagem estável),
  transporte JSONL com correlação, término falhando pendentes, timeout de
  request e sem travamento pós-término, conexão scoped com `detached`, stderr
  exposto, close sem fechar o scope do chamador e sem sleep fixo. Peer hermético
  - fixture curada. Revisão adversária aplicada; 28 testes no `vp test run`, sem
    Pi instalado. Detalhes:
    [`14-runtime-jsonl-e-contrato-do-pi.md`](issues/14-runtime-jsonl-e-contrato-do-pi.md).
- **15 — snapshot e catálogo scoped do Pi:** snapshot inicial `checking`, probe
  descartável com uma conexão RPC, ponte interna via `--extension`, fallback
  para `get_available_models`, mapeamento `provider/modelId` com thinking
  editável e seam para retirar seleção obsoleta após refresh. Detalhes:
  [`15-snapshot-pi-e-modelos-scoped.md`](issues/15-snapshot-pi-e-modelos-scoped.md).
- **16 — sessões Pi por thread e continuidade:** `PiSessionManager` mantém o
  vínculo 1:1 por `session-id` determinístico dentro do `session-dir` isolado,
  inicia sob demanda, reutiliza enquanto ativo e encerra pelo child scope,
  stop, reaper ou crash. O `resumeCursor` versionado valida identidade,
  namespace e histórico; retomada impossível falha sem reconstruir contexto.
  Detalhes: [`16-sessoes-pi-e-continuidade.md`](issues/16-sessoes-pi-e-continuidade.md).
- **17 — adapter Pi de turnos e eventos:** `PiAdapter` traduz o RPC de sessões
  em `ProviderRuntimeEvent`, mantém `agent_settled` como terminal autoritativo,
  aplica modelo/thinking in-session, preserva tools/subagentes como itens
  genéricos e trata erros locais, abort, processo morto e UI bloqueante sem
  travar a sessão. Detalhes:
  [`17-adapter-pi-turnos-e-eventos.md`](issues/17-adapter-pi-turnos-e-eventos.md).
- **18 — anexos de imagem até o Pi:** `PiAdapter` reutiliza o storage e a
  resolução de anexos existentes, converte bytes para `images` JSONL em ordem,
  permite prompt somente com imagem e rejeita MIME/conteúdo/modelo sem input de
  imagem. Capacidade desconhecida permanece tolerada e erro do Pi deixa a
  sessão recuperável. Detalhes:
  [`18-anexos-de-imagem-ate-o-pi.md`](issues/18-anexos-de-imagem-ate-o-pi.md).
- **MCP nativo do T3 somente no Pi principal:** extensão T3 sem imports com
  Streamable HTTP eager, wrapper temporário fora do projeto e bearer por
  thread; o manager injeta `--extension` apenas no processo principal,
  preserva extensões pessoais e revoga/limpa no stop, handshake falho ou crash.
  Detalhes: [`19-mcp-t3-somente-no-pi-principal.md`](issues/19-mcp-t3-somente-no-pi-principal.md).
- **21 — montagem e registro do `ProviderDriver` Pi:** `PiDriver` reúne
  snapshot, adapter, manager de sessões isoladas, anexos e o slot explícito de
  text generation não suportado. O Pi entra em `BUILT_IN_DRIVERS` via o
  envelope aberto `providerInstances`, sem chave legacy em `settings.providers`;
  web/mobile seguem os caminhos genéricos de display name e catálogo. A versão
  é lida antes do manager, e versão ausente/malformada fica incompatível até o
  probe confirmar um Pi real. Detalhes:
  [`21-montar-e-registrar-o-driver-pi.md`](issues/21-montar-e-registrar-o-driver-pi.md).

## Ainda não especificado

A névoa atual foi graduada para tickets. Não há área conhecida dentro do escopo
que ainda seja imprecisa demais para formular como pergunta.

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
- Geração auxiliar de texto pelo Pi (títulos de thread, nomes de branch,
  mensagens de commit, conteúdo de PR). O despacho é por instância selecionada,
  não pela thread, então o destino do mapa não passa por aqui; o slot existe e
  falha explícito. Decidido em
  [`20-papel-do-pi-em-text-generation.md`](issues/20-papel-do-pi-em-text-generation.md).
