# Como o Pi consome MCP

Type: research
Status: resolved
Blocked by: —

## Pergunta

O escopo dá ao T3 uma responsabilidade estreita e específica: **MCP nativo do T3
apenas para o agente principal Pi** — nunca para os subagentes. Para saber se
isso é sequer possível, é preciso descobrir como o Pi consome MCP.

Levantar:

- O Pi suporta servidores MCP? Nativamente, ou via extensão?
- Como um servidor MCP é declarado — `settings.json`, flag de CLI, algo passado
  pelo RPC na abertura da sessão?
- Dá para injetar um servidor MCP **por sessão/processo**, sem editar a
  configuração global de `~/.pi/agent` (que o escopo manda preservar)?
- O que os subagentes herdam da configuração do pai? Se herdam MCP
  automaticamente, o requisito "MCP só para o Pi principal" tem custo — qual?
- Transporte esperado pelo Pi (stdio, HTTP, SSE) e como isso se compara ao que o
  T3 já oferece hoje no servidor MCP nativo.

Olhar também o lado T3: como o servidor MCP nativo é exposto hoje e o que seria
preciso para apontá-lo a um processo Pi.

Entregar como documento de findings no repo.

## Answer

### Conclusão

O Pi core não tem MCP nativo. O cliente MCP disponível hoje é uma extensão —
`pi-mcp-extension` 1.5.0, publicada como pacote npm de terceiro — e o Pi core
também não tem subagentes nativos. Os dois recursos são deliberadamente
extensíveis. Isso torna o MCP nativo do T3 para o Pi principal viável, mas não
como uma opção já existente no RPC: o adapter precisa carregar a extensão e
fornecer a configuração/credencial da sessão.

Fontes primárias: [filosofia e limites do Pi no README upstream](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md),
[documentação de uso](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md),
[pacote `pi-mcp-extension`](https://pi.dev/packages/pi-mcp-extension) e
[código do pacote](https://github.com/irahardianto/pi-mcp-extension).

### Como o Pi consome MCP

- O Pi core afirma explicitamente “No MCP”; MCP é implementado por extensão ou
  pacote. O pacote atual é carregado com `pi install npm:pi-mcp-extension` ou
  somente para uma execução com `pi -e npm:pi-mcp-extension`.
- A extensão lê dois arquivos, nesta combinação: `~/.pi/agent/mcp.json` e
  `<cwd>/.pi/mcp.json`. O arquivo do projeto é mesclado sobre o global por
  nome de servidor; o override de uma entrada é raso, substituindo a entrada
  inteira. O loader não faz interpolação de variáveis de ambiente.
- Não há `--mcp-config`, comando RPC de configuração, ou campo de configuração
  MCP no comando `prompt`. O CLI oferece `--extension/-e`, `--mode rpc`,
  `--session-dir` etc., mas não uma injeção de servidor MCP. A extensão própria
  registra os comandos `/mcp`, `/mcp:start`, `/mcp:stop` e `/mcp:auth`.
- Cada entrada suporta `stdio`, `streamable-http` ou `sse`, com `lifecycle`
  `eager` (conecta em `session_start`) ou `lazy` (inicia por comando). Também
  há headers HTTP literais, inclusive `Authorization`, timeout, retry e
  `env` para processos stdio. As ferramentas viram nomes Pi no formato
  `<prefix>_<servidor>_<ferramenta>`.
- O ciclo de vida é da instância de Pi: a extensão desativa ferramentas e fecha
  conexões no `session_shutdown`. O servidor stdio filho é gerenciado pelo
  processo da extensão; HTTP/SSE permanecem como conexões do processo Pi.

Fontes: [`config.ts`](https://github.com/irahardianto/pi-mcp-extension/blob/main/src/config.ts),
[`index.ts`](https://github.com/irahardianto/pi-mcp-extension/blob/main/src/index.ts),
[`server-manager.ts`](https://github.com/irahardianto/pi-mcp-extension/blob/main/src/server-manager.ts)
e [documentação de extensões do Pi](https://pi.dev/docs/latest/extensions).

### Escopo por processo/sessão

Há uma forma de evitar a configuração global: carregar a extensão com `-e` no
processo principal e colocar a entrada em `<cwd>/.pi/mcp.json`. Isso é escopo do
processo/sessão somente se o arquivo for tratado como configuração efêmera e
for removido/restaurado pelo adapter. O pacote atual não tem uma API para
receber a configuração diretamente no `prompt` RPC.

Há duas limitações importantes para o driver:

1. O `pi-mcp-extension` usa `homedir()` diretamente para o caminho global
   `~/.pi/agent/mcp.json`; `PI_CODING_AGENT_DIR` altera a configuração do Pi,
   mas não cria um override de caminho para o `mcp.json` da extensão.
2. O arquivo de projeto é lido diretamente a partir de `cwd`, inclusive em
   modo RPC. Portanto, gerar um `.pi/mcp.json` temporário no projeto funciona,
   mas exige preservar o arquivo existente, serializar sessões concorrentes e
   limpar o segredo mesmo em crash. Não deve ser escrito em `~/.pi/agent`.

Para o T3, a opção mais estreita é o adapter iniciar o Pi principal com uma
extensão explicitamente passada por `-e` e fornecer endpoint, header bearer e
`lifecycle: "eager"` por um mecanismo de configuração por sessão. O ticket não
implementa esse mecanismo. Uma extensão T3 específica que aceite configuração
de sessão seria mais segura que editar configuração persistente do usuário.

### Subagentes e herança

O Pi core diz explicitamente “No sub-agents”. A extensão de exemplo de
subagentes cria uma nova instância `pi` por tarefa, com contexto isolado. O
spawn atual passa:

```text
--mode json -p --no-session [--model ...] [--tools ...]
```

e usa o mesmo `cwd` (ou o `cwd` solicitado) e `spawn()` sem `env` customizado;
portanto, o ambiente do processo pai é herdado pelo filho.

Consequências comprovadas pelo código da extensão de subagentes:

- Um MCP carregado somente no pai via `-e npm:pi-mcp-extension` não é passado
  automaticamente, porque o spawn não repete `-e`.
- Se `pi-mcp-extension` estiver instalado/ativado na configuração global ou
  como extensão descoberta no projeto, o filho também descobrirá essa extensão;
  usando o mesmo `cwd`, ele lerá o mesmo `<cwd>/.pi/mcp.json`. Cada subagente
  então terá sua própria conexão MCP e verá as mesmas ferramentas/credencial.
- A extensão MCP não verifica se está no agente principal, nem diferencia
  `PI_CODING_AGENT`; ela inicia servidores `eager` em todo `session_start`.
- O subagente não herda a conexão viva do pai; ele abre outra conexão. Ainda
  assim, se o arquivo/configuração for herdado, a credencial bearer e a
  identidade T3 serão compartilhadas. Isso viola “MCP somente para o Pi
  principal” e pode multiplicar processos, conexões e chamadas ao toolkit.

Fontes: [README do exemplo de subagentes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md),
[implementação do spawn](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts)
e [variáveis de ambiente do Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md).

Logo, para o MVP, carregar o MCP apenas via `-e` no processo principal é
compatível com a extensão de subagentes atual, desde que o pacote não esteja
simultaneamente habilitado de forma global/projeto. Se a implementação precisar
de um arquivo de projeto persistente ou instalar o pacote globalmente, será
necessário um guard explícito no processo filho ou alterar o harness de
subagentes para não carregar o MCP. `--no-extensions` não é uma solução neutra,
pois desabilita as extensões que o escopo quer preservar.

### Transporte e compatibilidade com o MCP nativo do T3

O T3 já expõe o MCP nativo como Streamable HTTP:

- [`McpHttpServer.ts`](../../../apps/server/src/mcp/McpHttpServer.ts) monta
  `McpServer.layerHttp` no caminho `/mcp`, no mesmo servidor HTTP do T3, usando
  o protocolo `2025-06-18`.
- [`McpSessionRegistry.ts`](../../../apps/server/src/mcp/McpSessionRegistry.ts)
  emite endpoint e `Authorization: Bearer ...` por thread/provider session,
  resolve o bearer em cada request e revoga a credencial ao encerrar a sessão.
- O middleware rejeita requests sem bearer válido; não existe transporte stdio
  do T3 nativo hoje.

O mapeamento para a extensão Pi é direto:

```json
{
  "mcpServers": {
    "t3-code": {
      "transport": "streamable-http",
      "url": "http://<host>:<port>/mcp",
      "headers": { "Authorization": "Bearer <token-da-thread>" },
      "lifecycle": "eager"
    }
  }
}
```

O `@modelcontextprotocol/sdk` 1.29.0 usado pela extensão lista
`2025-06-18` entre as versões suportadas. Portanto, não é preciso converter o
servidor T3 para stdio nem criar um proxy de transporte. A compatibilidade de
protocolo é suficiente para o handshake; a emissão/rotação/limpeza do bearer
continua sendo responsabilidade do adapter T3.

O código de adapters existentes confirma o padrão de integração do T3: eles
leem `McpProviderSession` e injetam a mesma URL/header em Codex, Claude, Grok,
Cursor e OpenCode. O adapter Pi deve seguir essa topologia, sem transformar o
MCP em ferramenta de subagente.

Fontes locais: [`McpHttpServer.ts`](../../../apps/server/src/mcp/McpHttpServer.ts),
[`McpSessionRegistry.ts`](../../../apps/server/src/mcp/McpSessionRegistry.ts),
[`McpHttpServer.test.ts`](../../../apps/server/src/mcp/McpHttpServer.test.ts) e
[`McpProviderSession.ts`](../../../apps/server/src/mcp/McpProviderSession.ts).

### Evidência de execução

Ambiente real disponível no host: `pi --version` retornou `0.84.1`.

1. Com uma instalação/configuração temporária do Pi, um mock MCP stdio em
   `/tmp` e `pi -e npm:pi-mcp-extension`, o RPC retornou:

   ```text
   MCP: 1/1 servers ready
     ✓ ticket02 (ready)
   ```

2. Repeti a execução com um mock HTTP em `127.0.0.1:43129/mcp`, configuração
   `transport: "streamable-http"` e header bearer. O RPC novamente retornou
   `MCP: 1/1 servers ready`; o mock registrou quatro requests, todos com
   `authorization=Bearer ticket-02-test-token`.

3. Os testes focados do T3 passaram:

   ```text
   pnpm exec vp test run apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/McpSessionRegistry.test.ts
   Test Files  2 passed (2)
   Tests       9 passed (9)
   ```

### Decisão para os próximos tickets

`02` está resolvido como investigação: o MCP nativo do T3 pode ser apontado ao
Pi principal por Streamable HTTP e bearer por thread. A implementação deve
resolver apenas a entrega efêmera dessa configuração e garantir que o processo
criado para subagentes não carregue a extensão/configuração T3. Não há suporte
nativo do Pi para injetar MCP no RPC nem para restringir automaticamente MCP ao
agente principal.
