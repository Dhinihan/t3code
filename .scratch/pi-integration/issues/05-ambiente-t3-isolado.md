# Ambiente T3 integrado isolado, coexistindo com o vanilla

Type: task
Status: resolved
Blocked by: —

## Pergunta

Nada neste mapa pode ser testado com segurança até existir um T3 rodando deste
checkout **sem tocar no estado do T3 vanilla**, que continua em uso diário no
mesmo computador ao mesmo tempo.

Trabalho a fazer (não há o que decidir — há o que montar e provar):

- Descobrir como o T3 resolve seu T3 home / diretório de userdata e sua porta, e
  qual é o mecanismo suportado para sobrescrever ambos (variável de ambiente,
  flag, config).
- Subir o server deste checkout com home, porta e banco de estado próprios.
- Provar a coexistência: T3 vanilla e T3 integrado rodando **simultaneamente**,
  sem colisão de porta, sem escrita cruzada de estado, sem pareamento
  compartilhado.
- Registrar o procedimento de start/stop como um comando ou script reproduzível,
  para as sessões seguintes não redescobrirem isso.

Resolvido quando os dois rodam juntos e o procedimento está escrito. A resposta
deve registrar: caminhos, porta, variáveis usadas e como subir cada um — fatos
que os tickets `06` em diante vão depender.

Cuidado: o `AGENTS.md` avisa que boa parte do trabalho neste repo acontece
_dentro_ do próprio T3. Não matar dev servers nem mexer no estado do T3 que
estiver conduzindo a sessão.

## Answer

O mecanismo suportado é o `scripts/dev-runner.ts` via `vp run dev`:

- `--home-dir <base-dir>` (equivalente a `T3CODE_HOME`) isola o estado em
  `<base-dir>/userdata`, incluindo o SQLite, autenticação e traces.
- `T3CODE_PORT_OFFSET` desloca as portas padrão (`13773` servidor e `5733`
  web); `T3CODE_DEV_INSTANCE` também fornece um offset estável por nome.
- `--port`/`T3CODE_PORT` fixa a porta do servidor; o web continua usando a
  porta derivada do offset. A linha `[dev-runner]` é a fonte de verdade.
- `t3 pair --base-dir <base-dir>` cria o pareamento no banco daquele ambiente.

Procedimento reproduzível, incluindo stop seguro e cautelas de PID, está em
[`docs/internals/pi-integration-t3-isolated.md`](../../../docs/internals/pi-integration-t3-isolated.md).

Prova realizada em 12/08/2026:

- vanilla existente: `127.0.0.1:3773`, home compartilhado
  `/home/vinicius/.t3/userdata`;
- checkout integrado: base
  `/home/vinicius/workspace/t3-com-pi/.t3/pi-integration-05`, servidor
  `127.0.0.1:14273`, web `localhost:6233`;
- ambos responderam HTTP 200 simultaneamente, inclusive o descriptor
  `/.well-known/t3/environment`;
- os bancos têm caminhos e inodes distintos, e os descriptors retornaram
  `environmentId` distintos;
- o processo integrado recebeu `T3CODE_HOME` próprio, `T3CODE_PORT=14273` e
  `VITE_DEV_SERVER_URL=http://localhost:6233`;
- runner iniciado e rastreado por este ticket: PID `3063733`; filhos observados:
  `3063758` (`vp`), `3063806` (watcher), `3063818` (server), `3063805`
  (web). O ambiente foi mantido vivo para os tickets seguintes.

O T3 vanilla e o desktop ativo não foram sinalizados nem encerrados. A única
operação adicional no home compartilhado foi uma leitura/probe de pareamento
que emitiu um link efêmero; nenhum arquivo do vanilla foi editado ou removido.

## Files changed

- `docs/internals/pi-integration-t3-isolated.md`
- `.scratch/pi-integration/issues/05-ambiente-t3-isolado.md`
