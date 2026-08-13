# Suíte do adapter Pi e detecção de drift do Pi

Type: grilling
Status: open
Blocked by: 01, 10, 11

## Pergunta

`11` fixou o procedimento de manutenção em uma frase que só funciona se a suíte
existir e for capaz de detectar drift: **"atualizou o Pi → rodar a suíte do
adapter"**. Se a suíte não distinguir "o Pi mudou" de "o adapter quebrou", o
passo 2 do procedimento é decorativo.

Somado à preferência fixada do mapa — adapters existentes têm suíte em par com a
implementação, e o código deve ser contribuível upstream — isto precisa de forma
antes de o driver ser fatiado.

Decidir:

- **O que é fixture.** `01` e `07` deixaram transcripts JSONL reais como assets.
  Eles viram fixtures versionadas, são regravados a cada release do Pi, ou
  servem só como referência humana?
- **Onde fica o test double do processo Pi.** Um fake que fala JSONL na memória,
  um binário stub em disco, ou o Pi real atrás de uma tag de teste de
  integração? A escolha decide se a suíte roda em CI sem o Pi instalado.
- **Como o drift aparece como falha legível.** O contrato de `11` é "novidade se
  ignora, ausência derruba" — a suíte precisa provar os dois lados: um evento
  com campo novo passa, um `get_state` sem `sessionId` falha. Qual é o teste que
  falha primeiro e com a mensagem certa quando o Pi muda?
- **Se existe um teste de contrato contra o Pi de verdade**, separado da suíte
  unitária — o que ele exercita, e se roda no procedimento de manutenção em vez
  de no CI.
- **Cobertura do piso de versão:** o comparador semver e as duas call sites
  (probe e spawn) compartilham a função; a suíte cobre a função, os dois call
  sites, ou ambos.
