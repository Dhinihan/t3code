# MCP nativo do T3 somente no Pi principal

Type: task
Status: open
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
