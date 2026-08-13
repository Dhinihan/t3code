# Handshake RPC e política de incompatibilidade

Type: grilling
Status: resolved
Blocked by: 01, 07

## Pergunta

O escopo exige que o handshake/versionamento RPC seja validado na inicialização e
que incompatibilidades sejam reportadas como erro de backend. O T3 não gerencia a
atualização do Pi — então o Pi _vai_ mudar debaixo desta integração, sem aviso.

Decidir:

- O que é verificado, e quando: na subida do server, na criação da instância do
  driver, ou a cada sessão?
- Qual é o critério de compatibilidade — versão exata, faixa, ou detecção por
  capabilities (mais robusto se o Pi não versionar o protocolo)?
- Como a falha se manifesta: instância indisponível (o T3 já tem o conceito de
  _unavailable shadow snapshot_), thread que falha ao iniciar, ou aviso não
  bloqueante? Qual dá ao usuário a mensagem mais útil.
- O que acontece se o usuário atualizar o Pi **com sessões vivas**.
- Compatibilidade parcial: se o Pi ganhar eventos que o adapter não conhece, o
  padrão é ignorar e seguir, ou falhar alto? Escolher o padrão que envelhece
  melhor.

O que sair daqui vira o passo 2 do procedimento de manutenção do escopo.

## Answer

### O fato que reformula a pergunta

O Pi não tem handshake e **não é enumerável**. `01` já havia estabelecido que
não existe mensagem inicial de versão ou negociação; esta sessão fechou o resto
da lacuna: `get_commands` devolve `RpcSlashCommand[]` — os slash commands
registrados por extensões (`dist/modes/rpc/rpc-types.d.ts:132-137`, resposta em
`:372-376`) — e **não** os comandos RPC. Não existe pergunta que faça o Pi
declarar se suporta `clone`, `compact` ou `set_thinking_level`; a única
descoberta possível é tentar e ler `Unknown command: X`.

Portanto "detecção por capabilities", que o ticket levantava como a opção mais
robusta, é fraca aqui: não há capabilities para detectar. O que sobra é a versão
do binário e a forma concreta das respostas.

### Critério de compatibilidade

Duas camadas, uma declarada e uma empírica:

1. **Piso de versão semver** sobre `pi --version`, começando em `0.84.1` — a
   versão contra a qual `01` e `07` capturaram evidência real. Abaixo do piso é
   incompatível.
2. **`get_state` validado por schema** como prova de vida do protocolo. Versão
   sozinha não protege contra um binário na versão certa que fala outra coisa;
   `get_state` é a menor troca que exercita envelope, correlação por `id` e os
   campos dos quais o adapter depende.

Precedente no repo, não invenção desta integração: o OpenCode já enforça
`MINIMUM_OPENCODE_VERSION = "1.14.19"`
(`apps/server/src/provider/Layers/OpenCodeProvider.ts:31`) com
`compareSemverVersions` (`:376-389`), produzindo `status: "error"` e a mensagem
"too old, upgrade to…". O comparador é `@t3tools/shared/semver`
(`packages/shared/src/semver.ts`).

### Onde e quando é verificado

`08` decidiu processo Pi sob demanda e reapado, então "na inicialização" precisa
ser desambiguado: **a verificação vive em uma função pura, chamada de dois
lugares.**

- **Probe do provider** (snapshot periódico): roda o piso e alimenta a UI. É o
  sinal que o usuário vê antes de abrir thread.
- **Handshake sintético no spawn** de cada processo Pi: um `get_state` antes do
  primeiro `prompt`, revalidando piso e schema. É o gate real.

A duplicação é deliberada e a função compartilhada é o que impede a incoerência
clássica de "UI verde, turno explode" — e o inverso. O `get_state` não é custo
extra: `09` já depende dele para confirmar o `sessionId` do vínculo.

### Como a falha se manifesta

**Camada do probe** — segue o precedente OpenCode: `installed: true`,
`status: "error"`, `models: []`, mensagem com a versão encontrada e a exigida.

Explicitamente **não** usa `availability: "unavailable"`. Esse termo tem
significado próprio no T3 — "instância que referencia um driver que este build
não implementa" (`apps/server/src/provider/unavailableProviderSnapshot.ts:1-12`,
`packages/contracts/src/server.ts:112-114`) — e é ele que faz
`ProviderAdapterRegistry.getByInstance` recusar o turno com
`ProviderUnsupportedError` (`Services/ProviderAdapterRegistry.ts:46-58`). Um Pi
velho é um driver que existe com binário errado, não um driver ausente;
sobrecarregar o termo confundiria o modelo e a UI de recuperação.

Consequência aceita: o probe **não bloqueia** `thread.create`, que nem lê o
snapshot do provider (`apps/server/src/orchestration/decider.ts:352-383`). Isso
é o comportamento existente para todos os drivers com CLI quebrado, não uma
regressão introduzida aqui.

**Camada do processo** — o handshake que falha produz erro de backend tipado: o
turno falha, a thread T3 e o arquivo de sessão Pi são preservados, o processo
filho é encerrado, e **não há retry**. Piso violado e schema inesperado são
falhas determinísticas; repetir só adia a mensagem. Também não se degrada para
"seguir sem `get_state`" — sem o `sessionId` confirmado, o vínculo de `09` fica
sem fundamento.

### Estrito ou tolerante

Tolerante na decodificação, consistente com `10`: campo desconhecido em resposta
ou evento conhecido é ignorado, o que se conhece é decodificado. O Pi ganha
campos sem aviso, e derrubar por campo extra transformaria cada release do Pi em
incidente.

A falha continua alta quando falta algo **obrigatório** — `sessionId` ausente em
`get_state`, `id` que não correlaciona, envelope fora da forma
`{ id, type, command, success, data|error }`. Isso é incompatibilidade real, não
novidade. A regra que envelhece melhor: **novidade se ignora, ausência derruba.**

### Atualização do Pi com sessões vivas

Nada é feito no ar. **O processo é a unidade de compatibilidade**: um processo
vivo continua com o binário que já carregou, e o próximo spawn revalida — não há
derrubada proativa nem aviso de versão trocada.

O risco real não é o processo vivo, é a **sessão**: um arquivo JSONL escrito por
0.84 reaberto por uma 0.9x. `09` já manda falhar explícito nesse caso. Este
ticket acrescenta um detalhe barato: gravar a versão do Pi no `resumeCursor`,
junto do schema version e do `sessionId`, para que a mensagem de erro diga
_qual_ versão escreveu a sessão em vez de um genérico "arquivo incompatível".

### Manutenção do piso — passo 2 do procedimento

Só piso, **sem teto**. Versão acima do piso é sempre aceita; o piso sobe
manualmente quando um teste real quebrar.

Teto bloqueante transformaria toda atualização do usuário em pane; teto com
aviso vira ruído que ninguém lê. Nenhum dos dois se paga contra um binário que
muda sem release notes contratuais.

O procedimento fica: **atualizou o Pi → rodar a suíte do adapter.** Se quebrar,
o diagnóstico já vem endereçado pela regra acima — ou é piso (versão), ou é
ausência de campo obrigatório (schema) — e subir o piso é uma linha.

### Vocabulário fixado nesta sessão

- **Piso de versão do Pi** — versão semver mínima do binário aceita pela
  integração. Começa em `0.84.1`. Não existe teto.
- **Handshake sintético** — o `get_state` que o adapter emite no spawn de cada
  processo Pi. Sintético porque o Pi não oferece handshake; quem o constrói é o
  host.
- **`unavailable`** (termo pré-existente do T3, aqui protegido) — instância cujo
  driver este build não implementa. **Não** se aplica a Pi velho ou quebrado.
