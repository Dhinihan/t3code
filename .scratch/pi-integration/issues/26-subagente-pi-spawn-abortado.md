# Pi: tornar o contrato de subagentes explícito no RPC

Type: task
Status: resolved
Blocked by: —

## Pergunta

Investigar e definir o comportamento de `subagent_spawn` quando um Pi principal
rodando dentro do T3 tenta iniciar um subagente com harness `pi`.

## Reprodução observada

Na thread `78695f91-28bf-4263-aa0e-c42c28237e56`, usando o ambiente isolado da
aceitação mobile e o modelo `cursor/grok-4.5`:

- o Pi carregou a skill `delegar-subagentes`;
- solicitou `subagent_spawn` com `harness: "pi"`, `reasoning_effort:
"minimal"` e um prompt read-only de smoke test;
- a chamada retornou `Subagent spawn aborted.`;
- nenhum resultado do subagente foi produzido;
- o turno terminou como `failed`, mas a thread permaneceu recuperável e o
  turno seguinte terminou normalmente.

## Critérios de aceitação

- reproduzir o caso no ambiente hermético e identificar por que o spawn é
  abortado, distinguindo ausência de capability, roteamento incorreto,
  cancelamento e falha ao iniciar o processo filho;
- decidir e registrar se subagentes Pi fazem parte do contrato suportado do
  T3 no MVP;
- se forem suportados, executar o smoke test completo, emitir o tool call
  genérico com início, atualização/resultado e conclusão, e manter o turno
  principal encerrando normalmente;
- se não forem suportados, retornar um erro/capability explícito e visível em
  vez de `Subagent spawn aborted`, sem deixar o turno bloqueado e permitindo um
  novo envio na mesma thread;
- garantir que nenhum processo filho fique órfão após sucesso, falha ou
  interrupção;
- preservar a política existente de subagentes como tool calls genéricas, sem
  criar threads T3 filhas nem expor gerenciamento individual no mobile;
- adicionar teste focado para sucesso ou rejeição suportada, encerramento do
  turno principal e recuperação da sessão.

## Fora de escopo

- construir UI de gerenciamento de subagentes;
- adicionar MCP do T3 aos subagentes;
- alterar as extensões pessoais instaladas no `~/.pi/agent`;
- implementar allowlist de slash commands, que está registrada no ticket 25.

## Relação

Encontrado durante a aceitação ponta a ponta mobile do ticket 23. O primeiro
turno da reprodução falhou pelo spawn abortado; a finalização do turno em si
não ficou presa.

## Answer

### Diagnóstico

A reprodução foi feita duas vezes: no ambiente T3 preservado da aceitação e
com um cliente JSONL cru falando diretamente com `pi --mode rpc`. O stream
confirmou `tool_execution_start` para `subagent_spawn` com `harness: "pi"`,
seguido imediatamente por `tool_execution_end` com `Subagent spawn aborted.` e
`agent_settled`. Não houve comando RPC `abort`, portanto não foi cancelamento
do usuário; também não houve um processo Pi filho para morrer ou deixar órfão.

O texto é o fallback de interrupção da extensão `subagents`. O backend `pi`
cria subagentes como `AgentSession` in-process. Ao bindar as extensões do
filho, o pacote pessoal `pi-cursor-sdk` reutiliza estado global de escopo de
sessão; o `session_start` do filho substitui o escopo do pai e o ciclo de vida
Cursor descarta o agente pai. Isso interrompe o `AbortSignal` da chamada
externa durante o startup do filho. A evidência detalhada está em
[`26-rpc-subagent-cursor-abort.transcript.md`](../assets/26-rpc-subagent-cursor-abort.transcript.md).

O caminho não é falta de capability nem roteamento incorreto. O contrato
genérico funciona com `openai-codex/gpt-5.6-luna`, como prova o transcript do
ticket 01 em [`01-rpc-subagent.transcript.md`](../assets/01-rpc-subagent.transcript.md).

O RPC não carrega uma causa tipada para todo abort interno. Assim, a
classificação no adapter é deliberadamente estreita: abort solicitado pelo T3
continua sendo `turn.aborted`; falha de transporte não produz esse ciclo de
tool/`agent_settled`; somente a assinatura observada de Cursor (`harness: pi`,
modelo `cursor/*` e o fallback literal) recebe o diagnóstico de capability.
Outros aborts internos continuam com o erro original, em vez de serem
inventados como indisponibilidade.

### Decisão de contrato

`subagent_spawn` continua sendo uma tool call genérica do Pi, sem threads T3
filhas e sem gerenciamento individual no mobile. O suporte é mantido para
modelos Pi que não compartilham esse estado global; nested Pi sob modelos
`cursor/*` fica explicitamente fora do suporte do MVP atual. Alterar a extensão
pessoal que causa a colisão está fora deste ticket.

O `PiAdapter` agora reconhece a combinação observável e específica de:

- `subagent_spawn` com `harness: "pi"`;
- modelo ativo `cursor/*`;
- resultado de erro exatamente `Subagent spawn aborted.`;
- ausência de uma interrupção solicitada pelo T3.

Nessa combinação, o `turn.completed` terminal permanece `failed`, mas leva a
mensagem acionável de capability em vez de `This operation was aborted`. O
estado da sessão volta a `ready` pelo caminho normal de `agent_settled`, e um
novo envio na mesma thread é aceito. Um `interruptTurn` explícito continua
produzindo `turn.aborted` e nunca é reinterpretado como indisponibilidade de
subagente.

Como o backend Pi usa sessões filhas in-process, esse caminho não cria um
processo filho independente. O lifecycle do processo Pi principal continua sob
o `PiRpcConnection`, que encerra o grupo POSIX no stop/crash.

### Verificação

- `PiAdapter.test.ts`: cenário de rejeição explícita, encerramento terminal,
  retry na mesma sessão e distinção de interrupção manual;
- `pnpm exec vp test run apps/server/src/provider/Layers/PiAdapter.test.ts` —
  12 testes passando;
- `pnpm --filter t3 typecheck` — concluído; somente sugestões preexistentes em
  arquivos não tocados.

## Comments

- Implementado no adapter Pi e coberto por teste focado. O transcript cru foi
  preservado como asset para que a distinção entre capability, cancelamento e
  colisão de lifecycle não dependa apenas da mensagem do modelo.
