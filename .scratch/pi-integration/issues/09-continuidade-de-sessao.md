# Continuidade: thread T3 × sessão Pi

Type: grilling
Status: resolved
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

## Answer

### Autoridade e vínculo

O T3 é a fonte de verdade da thread que o usuário vê; a sessão Pi é a fonte de
verdade apenas do contexto interno que o modelo continua. Os históricos são
persistidos pelos dois sistemas para finalidades diferentes e não são
reconciliados nem reidratados um a partir do outro.

Cada thread T3 possui uma sessão Pi estável e exclusiva. O adapter persiste o
vínculo no `resumeCursor`, com versão de schema e `sessionId`, e sempre retoma
esse ID. `continuationIdentity` / `continuationKey` não identifica a sessão da
thread: ele apenas diz se duas instâncias de provider compartilham um namespace
de retomada compatível. A troca entre instâncias só pode ser permitida quando
elas apontam para o mesmo namespace de sessões Pi.

### Isolamento

As sessões ficam em `<T3 home>/userdata/pi/sessions`, passado explicitamente por
`--session-dir`. O Pi continua lendo configuração, autenticação e extensões de
`~/.pi/agent`, mas não mistura o histórico criado pelo T3 com as sessões do Pi
vanilla.

### Retomada e falha no MVP

Reabrir uma thread antiga retoma a sessão Pi original. Se o arquivo estiver
ausente, corrompido ou incompatível com a versão instalada do Pi, o adapter
falha explicitamente como erro de backend e preserva a thread T3. Não cria uma
sessão vazia e não tenta reconstruir contexto a partir das mensagens visíveis.

Essa política é deliberadamente estreita para o MVP pessoal: primeiro valida o
fluxo ponta a ponta; restauração, migração ou uma ação explícita de reinício de
contexto serão priorizadas depois, conforme falhas reais aparecerem. A
reconstrução automática seria especialmente perigosa porque o histórico T3 não
reproduz com fidelidade ferramentas, efeitos, compactações e estado interno do
Pi.

### Bifurcação nativa

O T3 atual não possui uma operação genérica de bifurcação de thread. Se essa
superfície for adicionada, o adapter deve reutilizar a operação nativa `clone`
do RPC Pi para copiar a ramificação ativa inteira. `fork(entryId)` tem outra
semântica: cria uma sessão antes de uma mensagem de usuário escolhida, própria
para reedição a partir daquele ponto.

Verificação real no Pi `0.84.1`, com as extensões atuais e `--session-dir`
isolado: `clone` criou um novo `sessionId` e arquivo no mesmo diretório, gravou
`parentSession`, herdou as duas mensagens do pai e permitiu divergência. Pai e
filho foram retomados separadamente por ID; o pai permaneceu com duas mensagens
e o filho com quatro. A origem precisa estar assentada e já possuir resposta
persistida. Como `clone` troca o runtime chamador para o filho, uma futura
integração deve atualizar ou encerrar imediatamente o binding desse processo
para que a thread pai nunca envie ao filho.

### Compactação

O Pi é dono da compactação de seu contexto. O T3 pode transportar os eventos
genéricos relevantes para observabilidade, conforme o mapeamento de eventos,
mas não inicia, replica nem interpreta a compactação para reconstruir histórico.
Sua thread visível permanece independente da representação compactada usada
pelo Pi.
