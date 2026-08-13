# Sessões Pi, processos e continuidade por thread

Type: task
Status: open
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
