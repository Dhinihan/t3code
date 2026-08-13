# Pi: resposta duplicada quando os deltas contêm espaços

Type: task
Status: resolved
Blocked by: —

## Pergunta

Corrigir a duplicação de texto nas respostas do Pi quando a mensagem é
recebida em mais de um `text_delta`.

## Reprodução observada

Durante a aceitação mobile do ticket 23, o Pi respondeu uma única vez, mas o
celular mostrou a resposta duplicada.

Evidência no ambiente isolado:

- o log do Pi tem um único `item.completed` de `assistant_message`;
- o servidor persistiu um único turno e uma única mensagem assistant;
- o texto final emitido pelo Pi tinha 54 caracteres;
- o texto persistido tinha 98 caracteres;
- o problema ocorreu com o modelo Pi scoped `cursor/grok-4.5`.

## Causa provável

`apps/server/src/provider/Layers/PiAdapter.ts` usa `stringValue` para ler
`update.delta`. Essa função chama `trim()` em cada delta, removendo os espaços
nas fronteiras dos chunks. Em `completeAssistantItem`, o texto acumulado deixa
de ser prefixo do texto final de `message_end`; a comparação falha e o adapter
emite o texto final completo como se fosse um novo delta, concatenando-o ao
texto parcial.

## Critérios de aceitação

- preservar exatamente os espaços e quebras de linha dos `text_delta` e do
  conteúdo final;
- emitir a resposta uma única vez quando o texto final repete o conteúdo já
  transmitido;
- adicionar teste com chunks separados em uma fronteira de espaço;
- manter intactos reasoning, tools, múltiplos itens assistant e a finalização
  normal de turno;
- repetir a prova mobile do ticket 23 e confirmar que a mensagem persistida e
  exibida têm o mesmo conteúdo e uma única ocorrência.

## Relação

Encontrado durante `.scratch/pi-integration/issues/23-aceitacao-mobile-pi-ponta-a-ponta.md`.

## Answer

O `PiAdapter` agora preserva o texto bruto dos deltas, do reasoning e do
conteúdo final. Campos de protocolo que exigem conteúdo continuam usando a
leitura normalizada; apenas conteúdo textual usa a nova leitura sem `trim()`.

O teste regressivo envia `"hello "` e `"world\n"` em deltas separados e depois
recebe `"hello world\n"` em `message_end`. A prova confirma que o adapter emite
os dois deltas sem alteração e conclui um único item assistant com o texto
exato.

Validação executada:

- 10 testes do `PiAdapter`;
- typecheck do servidor;
- lint e formatação dos dois arquivos alterados.

O typecheck mostrou apenas sugestões preexistentes fora deste escopo. A prova
física no celular permanece no ticket 23.

## Comments

- Correção implementada e validada localmente. O `pnpm-lock.yaml` alterado no
  worktree não pertence a este ticket e não entra no commit.
