# MCP nativo do T3 somente no Pi principal

Type: task
Status: resolved
Blocked by: 14, 16

## Pergunta

Implementar a entrega efêmera do MCP nativo do T3 à sessão Pi principal,
seguindo os fatos de **Como o Pi consome MCP**:

- obter endpoint Streamable HTTP e bearer por thread via `McpProviderSession`;
- carregar no processo principal uma extensão T3 específica por `--extension`,
  sem instalar pacote nem escrever em `~/.pi/agent` ou no projeto do usuário;
- entregar configuração e credencial por sessão sem persistência, revogando e
  limpando no encerramento/crash;
- conectar eager ao `/mcp` do T3 e expor as ferramentas ao Pi principal;
- garantir por construção e teste que subprocessos da extensão de subagentes
  não recebem a extensão, a configuração nem o bearer do T3;
- coexistir com as extensões pessoais do Pi sem habilitar MCPs externos como
  parte desta iniciativa.

Os testes devem usar servidor/credencial descartáveis, provar autorização e
revogação e observar que um subagente não abre conexão MCP T3.

## Answer

Implementada a ponte MCP efêmera do T3 para o processo Pi principal, sem
instalação de pacote e sem escrita em `~/.pi/agent` ou no projeto do usuário.

- `PiT3McpExtension.ts` é uma extensão sem imports que fala diretamente
  Streamable HTTP: conecta eager no `session_start`, lista as ferramentas,
  publica nomes `t3_*`, encaminha `tools/call` com o bearer da thread e fecha a
  sessão com `DELETE` no `session_shutdown`.
- `PiMcpSession.ts` cria um wrapper temporário com modo `0600`, fora do cwd,
  contendo apenas endpoint e credencial daquela sessão. O lease é idempotente,
  remove o arquivo e revoga exatamente o `providerSessionId`; a limpeza é
  registrada no child scope para cobrir falha de spawn, handshake e crash.
- `PiSessionManager` adiciona somente o `--extension` do wrapper ao processo
  principal, preserva extensões pessoais passadas pelo caller e reinicia a
  sessão quando a credencial da thread muda. O bearer não é colocado no
  ambiente nem em argumentos. Como subagentes não recebem esse `--extension` e
  o wrapper não é descoberto em configuração global/projeto, eles não abrem o
  MCP T3; o teste de lifecycle confirma a ausência de configuração/bearer no
  spawn do Pi e a preservação das extensões pessoais.
- `McpSessionRegistry` ganhou revogação por provider session e
  `McpProviderSession` ganhou limpeza condicional, evitando que o cleanup de
  uma sessão antiga remova a credencial recém-emitida da mesma thread.

Cobertura focada: 18 testes passaram em quatro arquivos, incluindo servidor e
credencial descartáveis, autorização, listagem/call, revogação, limpeza no
stop/crash e wrapper fora do projeto. Também passaram lint focado, typecheck do
pacote `t3` e `git diff --check`. Um smoke contra o Pi instalado 0.84.1 confirmou
o handshake real `initialize → tools/list → DELETE`.
