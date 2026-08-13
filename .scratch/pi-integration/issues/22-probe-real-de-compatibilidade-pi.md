# Probe real de compatibilidade contra o Pi instalado

Type: task
Status: resolved
Blocked by: 14, 15, 16, 17, 18

## Pergunta

Transformar o procedimento decidido em **Suíte do adapter Pi e detecção de
drift do Pi** num comando permanente de manutenção, separado do runner normal:

- executar `pi --version` e aplicar o piso aceito;
- iniciar o Pi real em diretórios de sessão temporários e isolados;
- validar handshake, catálogo scoped, thinking, turno de texto, ferramenta,
  abort, encerramento e retomada;
- passar respostas/eventos pelos decodificadores de produção;
- destacar campos e eventos novos para inspeção, mas falhar somente em requisito
  ausente ou forma incompatível;
- não regravar fixtures automaticamente, não vazar segredos e limpar todos os
  processos/arquivos temporários.

Documentar o comando no procedimento “atualizou o Pi → probe real → investigar
→ suíte hermética”. Ele pode exigir instalação, autenticação e chamadas reais
do Pi, mas não roda em CI nem sob `vp test run`.

## Answer

Implementado o probe manual permanente em
[`apps/server/scripts/pi-compatibility-probe.ts`](../../apps/server/scripts/pi-compatibility-probe.ts),
com o atalho `pnpm probe:pi` (opções repassadas após `--`). Ele:

- verifica `pi --version` contra o mesmo piso compartilhado `0.84.1` usado pela
  compatibilidade de produção;
- cria uma sessão temporária isolada e exercita handshake, catálogo scoped,
  thinking, texto, ferramenta, abort, shutdown e resume usando transporte e
  decodificadores de produção;
- registra apenas nomes de campos/eventos desconhecidos, sem payloads, caminhos
  sensíveis ou stderr bruto; falha em requisito ausente ou forma incompatível;
- usa `Effect` scoped para limpar processo e diretório temporário e nunca altera
  fixtures. A saída pode ser textual ou `--json`.

Também foi adicionado o decoder tolerante da resposta de thinking e a suíte
hermética do probe em
[`apps/server/scripts/pi-compatibility-probe.test.ts`](../../apps/server/scripts/pi-compatibility-probe.test.ts).
O procedimento está em
[`docs/internals/pi-compatibility-probe.md`](../../docs/internals/pi-compatibility-probe.md)
e no índice de scripts.

Evidências:

- `22` testes focados passaram;
- typecheck do servidor e lint dos arquivos alterados passaram;
- probe real em Pi `0.84.1`: `version`, `handshake`, `catalog`, `thinking`,
  `text`, `tool`, `abort`, `shutdown` e `resume` passaram, sem novidades;
- nenhum diretório `t3-pi-compatibility-probe-*` permaneceu em `/tmp`.
