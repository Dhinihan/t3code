# Ambiente T3 isolado para a integração Pi

Este checkout pode rodar ao lado do T3 vanilla usando um base dir explícito e
portas próprias. O procedimento abaixo não toca em `~/.t3/userdata`.

## Controles suportados

- `--home-dir <base-dir>` é a forma explícita de escolher o T3 home. É
  equivalente a `T3CODE_HOME=<base-dir>` e grava o estado em
  `<base-dir>/userdata`, incluindo `state.sqlite`, `server-runtime.json`,
  sessões de autenticação e traces.
- Sem `--home-dir`, o dev-runner prefere o `.t3` do worktree. A preferência
  existe para não herdar o `T3CODE_HOME` do T3 que hospeda o agente, mas o
  caminho explícito continua sendo a opção mais fácil de auditar.
- `T3CODE_PORT_OFFSET` desloca o par de portas do dev runner: servidor `13773 +
offset` e web `5733 + offset`. `T3CODE_DEV_INSTANCE` também escolhe um
  deslocamento estável por nome. `--port`/`T3CODE_PORT` fixa somente a porta do
  servidor; o web continua vindo do offset.
- A linha `[dev-runner]` é a fonte de verdade das portas e do base dir. O
  `server-runtime.json` e `/.well-known/t3/environment` confirmam o processo
  que está respondendo.
- `node apps/server/src/bin.ts pair --base-dir <base-dir>` cria um token para
  o servidor daquele base dir. O token é armazenado no banco correspondente;
  não reutilize a URL de outro ambiente nem grave o token em logs ou arquivos.

## Start reproduzível do checkout integrado

Depois de instalar as dependências (`vp i`), a forma normal é:

```bash
ROOT="$(git rev-parse --show-toplevel)"
BASE="$ROOT/.t3/pi-integration-05"

T3CODE_PORT_OFFSET=500 \
  vp run dev \
  --home-dir "$BASE" \
  --port 14273
```

Isso reserva, quando livres, backend `127.0.0.1:14273` e web
`localhost:6233`, além de criar o banco em
`$BASE/userdata/state.sqlite`. Se `vp` não estiver no `PATH`, o mesmo runner
pode ser invocado diretamente com o binário local do Vite+:

```bash
ROOT="$(git rev-parse --show-toplevel)"
BASE="$ROOT/.t3/pi-integration-05"

PATH="$ROOT/node_modules/vite-plus/bin:$PATH" \
T3CODE_PORT_OFFSET=500 \
node "$ROOT/scripts/dev-runner.ts" dev \
  --home-dir "$BASE" \
  --port 14273
```

O comando permanece em foreground. Guarde o PID que ele imprime no shell ou
use `$$` antes do `exec`; não procure um PID por nome global:

```bash
echo "runner-pid=$$"
```

Para obter um pairing novo sem abrir navegador, em outro terminal:

```bash
ROOT="$(git rev-parse --show-toplevel)"
node "$ROOT/apps/server/src/bin.ts" pair \
  --base-dir "$ROOT/.t3/pi-integration-05"
```

Essa saída contém um segredo de uso único. Passe a URL diretamente ao cliente
que vai parear e não a cole em commits, screenshots ou logs duráveis.

## Stop seguro

No terminal que iniciou o stack, `Ctrl-C` é o caminho preferido. Se for
necessário sinalizar de outro terminal, use somente o PID capturado no start e
confirme sua identidade antes:

```bash
ROOT="$(git rev-parse --show-toplevel)"
RUNNER_PID=<pid-impresso-pelo-start>

test "$(readlink -f "/proc/$RUNNER_PID/cwd")" = "$ROOT"
tr '\0' ' ' <"/proc/$RUNNER_PID/cmdline" | grep -F -- "$ROOT/scripts/dev-runner.ts"
kill -INT "$RUNNER_PID"
```

O dev-runner encaminha a interrupção aos filhos `vp`, Vite e servidor. Não use
`pkill`, `pgrep | kill` ou um `kill` baseado em porta/nome para não atingir o
T3 vanilla ou outra sessão.

## Vanilla e coexistência observada

O T3 vanilla deste computador continua no home compartilhado
`~/.t3/userdata`, com o servidor observado em `127.0.0.1:3773`. O desktop T3
ativo também possui um servidor em `127.0.0.1:3774`; nenhum deles é alvo do
procedimento acima. O vanilla deve continuar sendo iniciado pelo launcher/app
instalado, sem apontar este checkout para `~/.t3`.

Em 12/08/2026, com ambos ativos, foram observados:

| ambiente   | base de estado                         | servidor | web/origem | prova                                            |
| ---------- | -------------------------------------- | -------: | ---------: | ------------------------------------------------ |
| vanilla    | `/home/vinicius/.t3/userdata`          |   `3773` |     `3773` | `/.well-known/t3/environment` HTTP 200           |
| integração | `$ROOT/.t3/pi-integration-05/userdata` |  `14273` |     `6233` | web `localhost:6233` HTTP 200 e backend HTTP 200 |

O processo integrado recebeu `T3CODE_HOME=$ROOT/.t3/pi-integration-05`,
`T3CODE_PORT=14273` e `VITE_DEV_SERVER_URL=http://localhost:6233`. Os bancos
têm caminhos, inodes e tamanhos distintos; o descriptor reportou IDs de
ambiente distintos. O pairing emitido para o base dir integrado apontou para
`127.0.0.1:14273`/`localhost:6233`, separado do alvo descoberto no home
compartilhado.

O web do dev runner pode aparecer como `[::1]:6233`; use `localhost:6233` ou
`[::1]:6233` nos probes, não assuma que `127.0.0.1:6233` estará ouvindo.
