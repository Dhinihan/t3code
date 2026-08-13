# Suíte do adapter Pi e detecção de drift do Pi

Type: grilling
Status: resolved
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

## Answer

### Critério: uma suíte que já possa subir numa PR

A preferência desta iniciativa por código contribuível upstream decide a forma
da suíte: ela deve rodar inteira no `vp test run`, sem Pi instalado, sem modelo,
rede, autenticação, `skipIf`, variável especial de CI ou limpeza posterior de
scaffolding. O Pi real não fica escondido dentro de um `*.test.ts`; a suíte
normal é hermética.

O precedente mais próximo no repo é a cobertura de colaboração do Codex:
`codexMultiAgentWire.json` guarda tráfego real com proveniência,
`CodexCollabWire.test.ts` exercita decisões puras contra a captura e
`CodexCollabRuntime.integration.test.ts` sobe o runtime de produção contra
`codexCollabMockPeer.mjs`, um processo stdlib que fala o protocolo pela fronteira
real. Os providers também usam test doubles de runtime para a cobertura larga
do adapter — por exemplo, `OpenCodeProvider.test.ts`. A suíte Pi combina os dois
padrões, em vez de inventar uma lane própria.

### Fixture de fio Pi

Um subconjunto das capturas reais de `01` e `07` vira fixture permanente e
curada em `apps/server/src/provider/testFixtures/`. Não são promovidos os 292 KB
inteiros de assets de investigação: entra somente o tráfego que representa o
contrato consumido pelo runtime e pelo adapter.

A fixture:

- registra proveniência, incluindo versão do Pi e cenário capturado;
- preserva envelopes e eventos reais relevantes;
- normaliza caminhos temporários, IDs, timestamps e outros valores instáveis;
- exclui autenticação, configuração pessoal e saída de modelo sem valor
  contratual;
- não é regravada automaticamente a cada release.

Fixture congelada detecta regressão; fixture regravada por rotina apenas move a
linha de base e pode esconder quebra. Ela só muda depois que o probe real acusa
novidade, a mudança é investigada, a nova forma é aceita deliberadamente e o
adapter é atualizado. Nenhuma ferramenta de manutenção a sobrescreve
automaticamente.

### Três níveis permanentes de teste

**1. Contrato puro do protocolo.** Schemas e transformações são testados sem
processo: envelopes, correlação por `id` e `command`, `get_state`, eventos
conhecidos, eventos/campos desconhecidos e conversão para eventos canônicos do
T3. Este é o nível que dá a falha mais específica quando a forma muda.

**2. Runtime contra peer JSONL scriptado.** Um processo Node stdlib em
`testFixtures` fala JSONL por stdin/stdout e replaya registros da fixture contra
o runtime de produção. Ele cobre framing por LF, separação de stderr,
intercalação de respostas e eventos, correlação, EOF, abort, morte do processo e
limpeza do filho. É infraestrutura definitiva de teste, equivalente ao peer do
Codex — não scaffolding descartável.

**3. Adapter com runtime substituível.** A cobertura larga usa um Effect test
double no seam do runtime, seguindo os adapters existentes. Cobre ciclo do
turno, texto, reasoning, ferramentas, término em `agent_settled`, erros
recuperáveis, preservação da sessão, ausência de retry em incompatibilidade
determinística e tradução para `ProviderRuntimeEvent`. Assim cada caso não
precisa subir processo, sem perder a prova real do transporte concentrada no
nível anterior.

### Como o drift falha de forma legível

A primeira falha de forma deve nascer no teste puro do contrato, não num teste
amplo do adapter. Casos mínimos obrigatórios:

1. `get_state` com campo adicional continua válido;
2. evento conhecido com campo adicional continua válido;
3. tipo de evento desconhecido é ignorado pelo adapter e pode ser registrado
   para diagnóstico;
4. `get_state` sem `sessionId` falha;
5. envelope sem correlação ou sem forma válida de sucesso/erro falha.

A falha é um erro de compatibilidade tipado, não o dump bruto de um
`Schema.ParseError`. Ele carrega operação (`get_state`), versão detectada do Pi
quando disponível, caminho/requisito ausente e causa original para logs. A
mensagem pública é estável e específica, na forma:

```text
Pi RPC get_state is incompatible: required field data.sessionId is missing (Pi 0.84.1).
```

Os testes fixam os campos estruturados e a mensagem pública, não a formatação
interna completa da biblioteca de schemas.

### Teste contra o Pi real: probe de compatibilidade

Detectar drift externo exige falar com o Pi real; uma suíte que só replaya
fixtures não pode fazer isso. O mecanismo é um comando explícito de manutenção,
no espírito de `apps/server/scripts/cursor-acp-model-mismatch-probe.ts`, e não
um teste opcional no runner.

O probe usa os decodificadores de produção e:

- executa `pi --version`;
- inicia `pi --mode rpc` em diretórios temporários isolados;
- valida `get_state` e consulta os modelos;
- executa turno de texto, turno com ferramenta e abort;
- testa encerramento e retomada da sessão;
- passa cada registro pelos mesmos decodificadores do adapter;
- relata eventos novos e incompatibilidades sem modificar fixtures.

Ele fica fora do `vp test run` porque exige Pi instalado, autenticação e chamadas
reais de modelo, mas é código permanente e contribuível — não um script em
`.scratch`. Campo novo é destacado para inspeção e não causa incompatibilidade;
a ausência de requisito ou quebra da forma fundamental causa falha.

O procedimento de `11` ganha uma separação honesta:

1. atualizou o Pi;
2. rodar o probe contra o Pi real para detectar drift externo;
3. investigar e adaptar conscientemente qualquer novidade relevante;
4. rodar a suíte hermética para detectar regressão do código;
5. atualizar a fixture somente quando a nova forma tiver sido aceita.

Em resumo: **probe real responde “o Pi mudou?”; suíte hermética responde “o
adapter ainda satisfaz o contrato aceito?”**.

### Cobertura do piso de versão

Não se repete a matriz completa de `compareSemverVersions`, que já pertence a
`packages/shared/src/semver.test.ts`. A política Pi cobre somente suas fronteiras:
abaixo de `0.84.1` rejeita, exatamente `0.84.1` aceita, acima aceita e versão
malformada produz erro legível.

Cada call site tem ainda um teste comportamental:

- **probe do provider:** Pi velho resulta em `installed: true`,
  `status: "error"`, `models: []`, sem usar `availability: "unavailable"`;
- **spawn da sessão:** incompatibilidade resulta em erro tipado, encerra o
  processo, não faz retry e preserva thread e arquivo de sessão.

O objetivo não é retestar semver duas vezes, mas provar que probe e spawn
aplicam a mesma política compartilhada.

### Vocabulário fixado nesta sessão

- **Fixture de fio Pi** — captura real, normalizada e versionada do protocolo
  JSONL aceito.
- **Peer Pi scriptado** — processo filho hermético que reproduz a fixture pela
  fronteira real de stdio.
- **Suíte hermética do adapter** — testes normais que não dependem de uma
  instalação do Pi.
- **Probe de compatibilidade Pi** — comando manual contra o binário real para
  detectar drift externo.
- **Drift de protocolo** — mudança observada no Pi real em relação ao contrato
  aceito; campo novo é novidade, ausência de requisito é incompatibilidade.
