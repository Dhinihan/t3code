# T3 Code com Pi — escopo aprovado

## Objetivo

Integrar o T3 Code ao Pi instalado no computador, preservando o valor do Pi e
das extensões já usadas no ambiente local. O T3 funciona como cliente/provider
adapter do Pi; não deve recriar no T3 as capacidades que já pertencem ao Pi.

Este checkout parte do `upstream/main` atualizado do T3 Code e vive em uma
pasta irmã de `misc`:

- vanilla/pesquisa: `/home/vinicius/workspace/misc/t3code-research`
- integração: `/home/vinicius/workspace/t3-com-pi`
- branch de trabalho: `pi-integration`

O Pi não é embarcado, copiado nem atualizado pelo T3. A integração usa o
executável, a configuração e as extensões disponíveis no computador, em
especial `~/.pi/agent`.

## Divisão de responsabilidades

### T3 Code

- transporte remoto, ciclo de vida e persistência;
- worktree, branch e diretório de trabalho;
- anexos e pipeline de imagens;
- conexão do cliente mobile;
- UI genérica de threads, mensagens, eventos, erros e resultados;
- adapter para iniciar e conversar com o Pi via RPC headless;
- MCP nativo do T3 somente para o agente principal Pi.

### Pi

- loop do agente e providers;
- ferramentas, skills e slash commands;
- seleção e execução de modelos/esforço;
- subagentes e seus harnesses;
- Claude, Codex e Cursor chamados pela extensão de subagentes;
- sessões, resultados e comportamento das extensões atuais.

O T3 não cria adapters individuais para Claude, Codex ou Cursor e não cria uma
segunda UI para os recursos do Pi.

## MVP

### Host e isolamento

- um único computador como host;
- um único usuário e baixa concorrência;
- Pi instalado no host, usando a versão atual do computador;
- configuração e extensões atuais de `~/.pi/agent` preservadas;
- estado/runtime do T3 integrado isolado do T3 vanilla, em diretório/pasta
  própria;
- worktree e branch continuam sob responsabilidade do T3;
- modo operacional `full-access`;
- handshake/versionamento RPC validado no início e erros de incompatibilidade
  reportados no backend.

### Cliente mobile e conexão

Faz parte explicitamente do MVP um APK de desenvolvimento do T3 conectado ao
host por rede direta:

- APK/dev build do `apps/mobile`;
- conexão por rede local ou Tailscale;
- conexão direta ao backend no computador;
- sem T3 Connect, relay ou outro serviço hospedado como dependência do fluxo;
- o T3 mobile não conversa diretamente com o MCP.

O build pode usar os mecanismos de development client já existentes no projeto,
como `dev:client` e o perfil Android de desenvolvimento. A implementação deve
preservar o fluxo nativo de conexão do T3, adaptando apenas o endpoint para LAN
ou Tailscale.

### Contrato Pi ↔ T3

- iniciar, continuar, interromper e encerrar sessões Pi;
- encaminhar texto, imagens, eventos, resultados e erros;
- preservar o fluxo genérico de ferramentas do T3;
- não adaptar aprovações nem questionários: o Pi não os usa neste ambiente;
- funcionalidades não suportadas podem retornar erro de backend;
- falhas devem deixar a thread recuperável, sem processos órfãos ou estado
  permanentemente em execução.

### Imagens

- entrada de imagens faz parte do MVP;
- reutilizar o pipeline de anexos existente no T3;
- encaminhar conteúdo e MIME para o Pi sem criar uma infraestrutura paralela;
- geração, edição e resultados de imagem próprios continuam fora do escopo.

### Subagentes

O agente principal Pi deve continuar podendo usar a extensão atual de
subagentes, incluindo:

- `subagent_spawn`;
- `subagent_wait`;
- `subagent_cancel`;
- `subagent_check`;
- `subagent_list`;
- paralelismo e limite de concorrência definidos pela própria extensão;
- todos os harnesses que a extensão atual já suporta.

O T3 apenas transporta as chamadas e resultados genéricos. Não cria threads T3
filhas, seletor de harness, FleetView, takeover ou gerenciamento individual de
subagentes no mobile.

Subagentes não recebem MCP do T3 no MVP. O MCP fica disponível somente ao Pi
principal. Isso evita acoplamento de credenciais, identidade de thread e estado
de browser compartilhado.

## Backlog

- UI própria do Pi no T3: FleetView, takeover, dashboard e transcript dedicado;
- gerenciamento individual de subagentes pelo mobile;
- threads T3 independentes para subagentes;
- subagentes com MCP do T3;
- MCPs externos configurados pelo usuário;
- descoberta, autocomplete e catálogo de slash commands específicos do Pi;
- geração, edição e fluxos próprios de imagens;
- múltiplos usuários, múltiplos hosts e alta concorrência;
- suporte garantido a extensões frontend do Pi;
- atualização automática ou empacotamento do Pi;
- matriz de versões suportadas do Pi.

## Atualização e manutenção

O T3 não gerencia a atualização do Pi. A manutenção da integração deve:

1. usar o Pi instalado no host;
2. validar o handshake RPC e a versão disponível;
3. preservar o carregamento das extensões atuais;
4. reportar incompatibilidades como erro de backend;
5. testar novamente a combinação T3 + versão local do Pi quando o usuário
   atualizar o Pi.

Não há compromisso de manter uma versão embarcada do Pi nem de garantir que
qualquer versão futura continue compatível sem validação.
