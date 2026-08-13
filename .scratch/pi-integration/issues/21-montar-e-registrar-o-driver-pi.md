# Montar e registrar o ProviderDriver Pi

Type: task
Status: resolved
Blocked by: 14, 15, 16, 17, 18, 19, 20

## Pergunta

Montar as peças já implementadas em uma instância funcional de
`ProviderDriver` e integrá-la ao fork com a menor pegada possível:

- driver/config schema e serviços `snapshot`, `adapter` e `textGeneration`;
- registro curto em `builtInDrivers.ts` e environment Effect necessário;
- instância Pi explícita em `providerInstances`, sem chave legacy nova em
  `settings.providers`;
- apresentação genérica suficiente para web/mobile selecionar a instância e
  seus modelos, usando fallbacks existentes onde ícone/polimento não forem
  obrigatórios;
- providers nativos preservados e nenhuma alteração desnecessária nos arquivos
  quentes identificados em **Anatomia de um driver T3 e a pegada de um
  `ProviderDriverKind` novo**.

Rodar os testes focados de server/contracts/clients e comprovar que o server
isolado publica o snapshot Pi pronto sem quebrar os providers existentes.

## Answer

O `ProviderDriver` Pi foi montado e registrado com a menor pegada possível.

- `apps/server/src/provider/Drivers/PiDriver.ts` concentra o schema de
  `binaryPath`, o ambiente Effect, o diretório isolado
  `stateDir/pi/<instanceId>`, o leitor de anexos, `PiSessionManager`,
  `PiAdapter`, `snapshot` gerenciado e o stub de `textGeneration`.
- A versão do Pi é lida antes de criar o manager; a sessão repete o handshake
  por `get_state` usando a mesma política de compatibilidade (`0.84.1`). Se a
  leitura falha, o manager recebe uma sentinela incompatível e não abre uma
  sessão por engano; o snapshot continua reportando o erro real.
- `builtInDrivers.ts` ganhou apenas o registro do Pi e sua união de ambiente.
  Codex, Claude, Cursor, Grok e OpenCode continuam na mesma ordem e sem
  alterações.
- A configuração usa somente `settings.providerInstances`; não foi criada uma
  chave `settings.providers.pi`. O `ProviderDriverKind` aberto e os fallbacks
  existentes de web/mobile já exibem a instância e os modelos do snapshot, por
  isso contracts e clients não precisaram de novos casos Pi.
- `PiTextGeneration.ts` implementa explicitamente as quatro operações como
  `TextGenerationError`, sem iniciar processo Pi.

### Evidência

- O peer Pi hermético de `PiProvider.test.ts` publica snapshot `ready`, versão
  `0.84.1` e modelo scoped com thinking.
- `PiDriver.test.ts` materializa uma instância explícita sem legacy key,
  confirma identidade/status e verifica que todos os drivers nativos continuam
  registrados ao lado de `pi`.
- Suíte Pi + registry: 15 arquivos, 73 testes aprovados.
- Contracts + web + mobile: 4 arquivos, 107 testes aprovados.
- `pnpm exec vp run --filter t3 typecheck` aprovado; `vp fmt --check` e
  `git diff --check` aprovados. Os únicos diagnósticos do typecheck são
  sugestões preexistentes fora desta mudança.
