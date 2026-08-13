# Pi: restringir slash commands a um allowlist seguro para RPC

Type: task
Status: claimed
Blocked by: —

## Pergunta

Simplificar a integração Pi removendo o repasse genérico de qualquer `/...` para
o `Pi.prompt` e definindo um allowlist explícito de comandos suportados no
contexto RPC/T3.

## Contexto

O Pi executa comandos de extensão antes de iniciar o ciclo normal do agente.
No RPC, o `prompt` é aceito, mas esse caminho pode retornar sem emitir
`agent_settled`. Como o `PiAdapter` usa `agent_settled` como encerramento
autoritativo do turno, extensões pessoais como `/quota` e `/hud` deixam o turno
do T3 em `running`, independentemente de a extensão depender ou não da TUI.

O problema também pode ser acionado digitando o comando manualmente, mesmo que
ele não esteja listado no picker. Portanto, esconder comandos na UI não é uma
proteção suficiente.

## Critérios de aceitação

- definir no seam do provider Pi um allowlist explícito para comandos de
  extensão aceitos pelo T3/RPC;
- manter separados os comandos próprios do T3, como `/model`, `/plan` e
  `/default`, que são tratados pelo cliente e não devem ser enviados como
  comandos de extensão do Pi;
- começar com allowlist vazio no MVP, ou apenas com comandos que tenham um
  contrato de conclusão verificável no RPC;
- rejeitar um slash command de extensão fora do allowlist antes de criar ou
  deixar preso um turno, com erro ou aviso visível e uma sessão pronta para um
  novo envio;
- garantir que `/quota`, `/hud` e qualquer extensão pessoal não permitida não
  sejam enviados ao caminho genérico de `Pi.prompt`;
- não descobrir, listar ou expor automaticamente todos os slash commands
  instalados no `~/.pi/agent`;
- adicionar testes para envio manual de comando permitido, comando não
  permitido, erro recuperável e envio normal de texto depois da rejeição;
- preservar o comportamento de texto que começa com `/` quando ele não for
  reconhecido como um comando de extensão permitido, conforme a decisão de
  produto registrada durante a implementação.

## Fora de escopo

- implementar suporte RPC para `/quota`, `/hud` ou outras extensões pessoais;
- alterar o pacote instalado do Pi;
- construir UI própria para extensões ou suporte à TUI dentro do T3;
- reintroduzir descoberta genérica de comandos para contornar o allowlist.

## Relação

Originado durante a aceitação mobile do ticket 23. O comportamento foi
confirmado nos comandos `/quota` e `/hud`; o ticket 24 registra o bug separado
de resposta duplicada.

## Comments

- Tarefa criada para posterior implementação. Nenhum código foi alterado neste
  ticket.
