# Continuidade: thread T3 × sessão Pi

Type: grilling
Status: open
Blocked by: 01, 04, 08

## Pergunta

Dois sistemas guardam a mesma conversa. O T3 possui a thread durável e o
histórico; o Pi possui a sessão em `~/.pi/agent/sessions` com `--session-id`,
`--continue`, `--fork`. Quem é a fonte de verdade, e o que acontece quando os
dois discordam?

Decidir:

- O mapeamento thread T3 → sessão Pi. Um-para-um estável? A SPI já oferece
  `continuationIdentity` / `continuationKey` — é o encaixe certo?
- Onde as sessões do Pi devem ser gravadas: no diretório padrão do Pi (que o
  vanilla também usa) ou em um `--session-dir` próprio do T3 integrado. O escopo
  manda preservar a configuração de `~/.pi/agent`, e isolamento é requisito.
- Se o histórico é duplicado (T3 renderiza sua cópia, Pi mantém o contexto) ou se
  o T3 reidrata a partir do Pi.
- Retomar uma thread antiga: o T3 continua a sessão Pi original, ou abre uma nova
  perdendo o contexto? O que acontece se o arquivo de sessão sumiu ou o Pi foi
  atualizado desde então.
- Fork de thread no T3, se existir, e o que ele significa do lado do Pi.
- Compactação: o Pi tem `compactions/`. Quem compacta, e o T3 precisa saber?
