# Runtime JSONL e contrato de compatibilidade do Pi

Type: task
Status: resolved
Blocked by: —

## Pergunta

Implementar a fronteira de processo/protocolo que permita ao server conversar
com `pi --mode rpc` sem ainda montar o adapter completo:

- processo filho scoped com stdin/stdout JSONL e stderr separado;
- framing LF, IDs de correlação e intercalação segura de respostas/eventos;
- schemas tolerantes a campos/tipos novos e estritos nos requisitos consumidos;
- comandos mínimos compartilhados por probe e sessão (`get_state`, modelos,
  thinking, prompt, abort e shutdown);
- piso semver `0.84.1` e handshake sintético tipado conforme a decisão de
  **Handshake RPC e política de incompatibilidade**;
- encerramento limpo, timeout, EOF, morte inesperada e ausência de processo
  órfão.

Construir junto a parte aplicável da **Suíte do adapter Pi e detecção de drift
do Pi**: testes puros do contrato, fixture de fio curada e peer JSONL scriptado
que exercite o runtime de produção sem Pi instalado. Este ticket termina com o
runtime reutilizável e hermeticamente testado; snapshot, sessões T3 e mapeamento
canônico de eventos ficam nos tickets seguintes.

## Answer

### Veredito curto

Implementada a fronteira de processo/protocolo em camadas, tudo em arquivos novos
sob `apps/server/src/provider/` — nenhum arquivo existente foi modificado
(fork rebaseável). A suíte é hermética e roda inteira no `vp test run`, sem Pi
instalado: 28 testes em 4 arquivos, typecheck e lint limpos. Uma revisão
adversária posterior (subagente Opus) apontou 11 achados; todos foram corrigidos
nesta sessão e a suíte passou a provar cada um.

### Revisão e correções

Uma revisão técnica encontrou: 4 testes de transporte vazios (`it` do
`@effect/vitest` sem `.effect`, corpo nunca rodava), `request` que travava após
o término (o `Queue.offer` retorna `boolean`, nunca falha; o branch de
recuperação era morto), envelope malformado reclassificado como evento e
engolido, kill de grupo POSIX inoperante (faltava `detached`), `close` que
fechava o scope do chamador, erro de compatibilidade tipado nunca construído,
tolerância estrita demais em campos opcionais do `get_state`, mensagem de erro
do Pi descartada, `exitCode` classificado mas jogado fora, `close` com sleep
fixo, e `Queue.shutdown` na fila de eventos. Todos corrigidos — a seção de
testes abaixo lista a prova de cada um.

### Camadas entregues

1. **Contrato puro** (`PiRpcContract.ts`) — schemas do envelope
   `{ id, type: "response", command, success, data|error }`, dos comandos
   mínimos compartilhados por probe e sessão (`get_state`, `get_available_models`,
   `get_available_thinking_levels`, `set_model`, `set_thinking_level`, `prompt`,
   `abort`) e dos eventos. Decodificação **tolerante**: excesso de propriedade e
   tipos de evento desconhecidos passam (regra "novidade se ignora"); falha em
   `sessionId` ausente, envelope fora da forma ou resposta sem correlação
   (regra "ausência derruba"). `decodeGetStateResponse` produz o handshake
   tipado com `sessionId` estrito e modelo/thinking opcionais.

2. **Política de compatibilidade** (`PiCompatibility.ts`) — a função pura única
   exigida pela decisão **Handshake RPC e política de incompatibilidade**:
   piso semver `0.84.1` (sem teto) via `compareSemverVersions` +
   `get_state` validado no `sessionId`. Probe (ticket 15) e spawn de sessão
   (ticket 16) chamam esta mesma função. O erro tipado `PiRpcCompatibilityError`
   carrega `operation`, `piVersion` e `missingRequirement`, com a mensagem
   pública estável do ticket 13:
   `Pi RPC get_state is incompatible: required field data.sessionId is missing (Pi 0.84.1).`

3. **Transporte JSONL** (`PiRpcProtocol.ts`) — port de
   `effect-codex-app-server/src/protocol.ts` para o envelope Pi (sem router de
   requests do servidor; o Pi é respondedor puro). Framing LF com remainder +
   strip de `\r`, fila de escrita, correlação por `Map<id, Deferred>` com
   remoção em sucesso/falha/interrupção, término (EOF ou morte) falhando todos
   os pendentes **exatamente uma vez** (via `Ref` atômico) e encerrando a fila.
   `request` **nunca trava**: checa `terminationHandled` antes de registrar,
   verifica o `boolean` do `Queue.offer` (fila fechada ⇒ falha tipada) e aplica
   um `requestTimeout` (30s na conexão) que vira `PiRpcRequestTimeoutError`.
   `makeInMemoryPiStdio` é o seam hermético (sem processo) para os testes de
   nível 1.

4. **Conexão scoped** (`PiRpcConnection.ts`) — spawn via `ChildProcessSpawner`
   - `resolveSpawnCommand`, `forceKillAfter`, **`detached` no POSIX** para o
     kill do grupo alcançar o Pi E os subagentes descendentes, stderr drenado e
     capturado (exposto via `connection.stderr`), `close` **não fecha o scope do
     chamador** — registra um finalizer no scope que mata o grupo (SIGTERM →
     SIGKILL após grace) e aguarda a saída do child com deadline em vez de um
     sleep fixo; fechar uma conexão não derruba uma irmã no mesmo scope (ticket
     16). `makeChildStdio` compartilha a fronteira real de stdio com o peer
     scriptado.

5. **Fixture de fio curada** (`testFixtures/piRpcWire.json`) — subconjunto das
   capturas reais do Pi 0.84.1 (`07-spike-rpc`), normalizado, com proveniência
   registrada; decodifica pelos schemas de produção (teste no contrato).

6. **Peer Pi scriptado** (`testFixtures/piRpcMockPeer.mjs`) — processo Node
   stdlib que fala o JSONL pela fronteira real, parametrizado por script
   (`PI_RPC_PEER_SCRIPT`) com `failCommand`, `deathOnCommand`, `stderrBytes`,
   `promptEvents` e grava sidecar de comandos recebidos. É infraestrutura
   permanente de teste, não scaffolding descartável.

### Testes (28, todos herméticos)

- `PiRpcContract.test.ts` (10): decodificação de `get_state` real, tolerância a
  campos novos, **tolerância a mudança de forma dos campos opcionais** do
  `get_state` (A7), ausência de `sessionId` rejeitada, **envelope malformado
  rejeitado em vez de virar evento** (A3/caso 5 do ticket 13), classificação de
  eventos (incluindo `extension_ui_request`), erro de comando, prompt, e a
  fixture curada passando pelos decodificadores.
- `PiCompatibility.test.ts` (5): piso exato aceita, acima aceita, abaixo
  rejeita com erro tipado, versão malformada erro legível, `sessionId` ausente
  falha **com a mensagem estável fixada** (A6).
- `PiRpcProtocol.test.ts` (6): correlação por id, intercalação de evento com
  resposta, tolerância a linha malformada e evento desconhecido, término
  falhando pendentes, **request após término falha em vez de travar** (A2), e
  **timeout de request sem resposta** (A2/timeout).
- `PiRpcRuntime.test.ts` (7, `it.live` contra o peer real): handshake +
  compatibilidade, stream de eventos intercalado com prompt, erro de comando
  **com a mensagem do Pi preservada** (A8), stderr alto sem bloquear, morte do
  filho no meio do protocolo, log de comandos recebidos, e **fechar uma conexão
  não derruba uma irmã no mesmo scope** (A5).

### O que ficou de fora (tickets seguintes)

- Snapshot do provider e catálogo scoped: **15**.
- Vínculo 1:1 thread↔sessão, `resumeCursor`, reaping/retomada: **16**.
- Adapter com eventos canônicos e `agent_settled`: **17**.
- Registro do driver (`BUILT_IN_DRIVERS`), `server.ts`, contracts: **21**.
- Probe real de compatibilidade contra o Pi instalado: **22**.

### Vocabulário fixado

- **Handshake sintético** — o `get_state` validado que o host emite no spawn,
  porque o Pi não oferece handshake (termo da decisão 11).
- **Peer Pi scriptado** — o processo hermético que reproduz a fixture pela
  fronteira real de stdio (termo do ticket 13).
- **`unavailable`** continua reservado ao driver ausente; Pi velho/estrito é
  `PiRpcCompatibilityError`, nunca `unavailable`.
