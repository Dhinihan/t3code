# Aceitação ponta a ponta: mobile na LAN conversando com o Pi

Type: task
Status: claimed
Blocked by: 24

## Pergunta

Executar e registrar a prova final do destino no ambiente isolado já preparado:

- iniciar o T3 integrado sem afetar o vanilla;
- conectar o APK de desenvolvimento pela LAN/Tailscale;
- selecionar uma instância/modelo Pi scoped no mobile;
- enviar texto e imagem em uma thread real;
- observar extensões pessoais e ao menos um subagente trabalhando como tool
  calls genéricas;
- observar o MCP nativo do T3 disponível somente ao Pi principal;
- interromper/retomar ao menos uma sessão e confirmar ausência de processo
  órfão;
- receber o resultado final na mesma thread do celular.

Registrar comandos, logs e evidência visual/funcional reproduzível. Este ticket
não adiciona UI própria do Pi nem amplia o escopo; falhas encontradas voltam
como tickets específicos, em vez de serem escondidas na prova de aceitação.

## Comments

- O pareamento pela LAN foi concluído no servidor isolado `14273` e o grupo Pi
  passou a aparecer no picker mobile.
- A primeira mensagem chegou ao Pi e terminou no mesmo thread, mas a resposta
  apareceu duplicada. O servidor registrou um único turno e uma única mensagem;
  o bug foi separado no ticket 24.
- A interrupção chegou ao Pi e gerou `turn.aborted`, mas a ingestão manteve a
  sessão como `running`. O bug compartilhado por web e mobile foi separado no
  ticket 27.
- O ticket 27 foi implementado no commit `60a60f89a` e validado com Pi real na
  web, incluindo novo envio na mesma thread e ausência de processo órfão. A
  prova equivalente no celular fica nesta aceitação, junto da validação do
  ticket 24.
