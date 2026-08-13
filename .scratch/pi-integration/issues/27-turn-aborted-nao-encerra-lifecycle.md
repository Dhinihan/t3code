# Interrupção: `turn.aborted` não encerra o lifecycle da thread

Type: task
Status: resolved
Blocked by: —

## Pergunta

Tratar `turn.aborted` como um evento terminal do turno na ingestão de eventos
dos providers, para que uma interrupção aceita libere a thread em todos os
clientes.

## Reprodução observada

Durante a aceitação do ticket 23, a interrupção falhou tanto na web quanto no
mobile. A reprodução usou a thread
`78695f91-28bf-4263-aa0e-c42c28237e56`, o turno
`0fa14dd6-7392-4766-83c0-440628fd15fe` e o modelo Pi scoped
`cursor/grok-4.5`.

O fluxo registrado foi:

- os clientes enviaram `thread.turn.interrupt`;
- o servidor processou `thread.turn-interrupt-requested`;
- `PiAdapter.interruptTurn` enviou o comando RPC `abort` e retornou com
  sucesso;
- o Pi abortou o comando em execução e o adapter emitiu `turn.aborted` com
  `Interrupted by user.`;
- a projeção continuou considerando a sessão `running`, manteve o controle de
  interrupção visível e aceitou vários cliques posteriores.

O evento canônico `turn.aborted` foi emitido em
`2026-08-13T14:28:15.894Z`. Portanto, o problema não está no transporte do
clique nem no RPC do Pi.

## Causa confirmada

`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` inclui
`turn.completed` no bloco que atualiza o lifecycle da sessão, mas não inclui
`turn.aborted`. O evento limpa apenas o progresso de plano. Ele não tira a
sessão de `running` nem limpa `activeTurnId`.

O reducer já marca `latestTurn` como `interrupted` quando processa
`thread.turn-interrupt-requested`. Isso deixa a projeção inconsistente: o
turno aparece interrompido, mas a sessão permanece ocupada.

## Critérios de aceitação

- adicionar um teste de ingestão que comece um turno, emita `turn.aborted` e
  prove que a sessão deixa de estar `running`, limpa `activeTurnId` e mantém o
  último turno como `interrupted`;
- manter a sessão reutilizável para iniciar outro turno na mesma thread após a
  interrupção;
- aplicar ao evento a mesma proteção de identidade usada para términos de
  turno, para que um `turn.aborted` atrasado não encerre um turno mais novo;
- tornar eventos repetidos de abort idempotentes e não reabrir nem alterar um
  turno já encerrado;
- preservar a finalização normal por `turn.completed` e os demais estados de
  sessão;
- repetir a prova na web e no mobile: iniciar trabalho longo, interromper uma
  vez, observar o controle de stop desaparecer e enviar uma nova mensagem na
  mesma thread;
- confirmar que a operação interrompida não deixa processo de ferramenta
  órfão.

## Fora de escopo

- alterar os botões de interrupção dos clientes;
- corrigir slash commands de extensões, cobertos pelo ticket 25;
- corrigir o spawn de subagentes, coberto pelo ticket 26;
- corrigir a duplicação de texto, coberta pelo ticket 24.

## Relação

Encontrado durante a aceitação ponta a ponta do ticket 23. A correção pertence
à ingestão genérica de eventos de provider, embora a reprodução tenha usado o
Pi.

## Answer

Implementado no commit `60a60f89a`. A ingestão agora trata `turn.aborted` como
um término interrompido, libera a sessão e limpa `activeTurnId`. A proteção de
identidade rejeita aborts repetidos ou atrasados para que eles não encerrem um
turno mais novo.

A validação cobriu:

- 49 testes de ingestão e 9 testes do `PiAdapter`;
- typecheck, lint e formatação dos arquivos alterados;
- interrupção contra um Pi real pela web, seguida de uma nova mensagem na
  mesma thread;
- encerramento sem processo Pi órfão.

A nova mensagem chegou ao provider e recebeu rate limit externo. Isso não
indica falha no lifecycle corrigido. O host não tem Android SDK ou ADB, então a
prova no celular ficou para a aceitação conjunta do ticket 23, depois da
correção da duplicação de texto no ticket 24.

## Comments

- Tarefa criada a partir dos logs da reprodução em web e mobile. Nenhum código
  foi alterado.
- Implementação e prova web concluídas. A prova mobile será registrada no
  ticket 23.
