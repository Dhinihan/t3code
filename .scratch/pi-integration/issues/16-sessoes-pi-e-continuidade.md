# Sessões Pi, processos e continuidade por thread

Type: task
Status: resolved
Blocked by: 14

## Pergunta

Implementar a camada de lifecycle que materializa as decisões de **Topologia de
processo e ciclo de vida do Pi** e **Continuidade: thread T3 × sessão Pi**:

- vínculo estável 1:1 entre thread T3 e sessão Pi no namespace isolado;
- spawn sob demanda do processo RPC, reaproveitamento enquanto ativo e
  encerramento scoped/reaping sem órfãos;
- `--session-dir` e `--session-id` determinísticos, com confirmação por
  `get_state` antes do primeiro prompt;
- `resumeCursor` versionado com session id, schema e versão Pi;
- retomada após reaping/restart e falha explícita, sem reconstrução automática,
  quando a sessão não puder ser reaberta;
- limpeza correta em stop, crash, handshake incompatível e reconcile de
  instância.

Este ticket deve expor um seam substituível para o adapter e testes de lifecycle
contra o runtime/peer hermético. O mapeamento dos eventos e comandos de turno
fica separado.

## Answer

Implementada a camada de lifecycle em `PiSessionManager.ts`, com um seam
substituível por `connect` para o adapter e por peer hermético nos testes.

- Cada thread recebe o ID determinístico `t3-<hex UTF-8 do ThreadId>`; o
  processo é iniciado com `--mode rpc`, `--session-dir` absoluto e
  `--session-id` estável.
- `start` confirma `get_state` antes de devolver a sessão, passa pela mesma
  política de compatibilidade do probe, reutiliza o processo ativo e fecha o
  child scope em falha de spawn/handshake, `stop`, `stopAll` ou encerramento do
  manager. O `exitCode` da conexão remove um processo crashado do mapa ativo,
  permitindo novo spawn sem adotar o processo morto.
- O `PiResumeCursor` é versionado e inclui `threadId`, `sessionId`, namespace
  (`sessionDir`), `sessionFile`, `cwd`, `piVersion` e `messageCount`. A retomada
  valida schema, identidade, namespace e histórico persistido; arquivo ausente
  ou sessão incompatível falha explicitamente, sem reconstrução automática.
- O transporte Pi ganhou o `exitCode` observável e a terminação normal da fila
  de eventos necessária para o lifecycle; os campos opcionais de `get_state`
  continuam tolerantes e agora carregam `messageCount` quando presente.

Testes em `PiSessionManager.test.ts` cobrem ID estável, handshake único e
reuso, limpeza de handshake incompatível, retomada após reconstrução do
manager, recusa de histórico ausente, remoção após crash e o peer JSONL real
hermético. A suíte focada passou: 5 arquivos, 35 testes. O typecheck
`pnpm exec vp run --filter t3 typecheck` e `git diff --check` também passaram.

O mapeamento de eventos/comandos de turno permanece no ticket 17; a integração
com o adapter/driver usa este seam e o `ProviderSessionDirectory` nos tickets
seguintes.
