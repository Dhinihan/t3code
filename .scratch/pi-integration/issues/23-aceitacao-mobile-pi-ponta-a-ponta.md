# Aceitação ponta a ponta: mobile na LAN conversando com o Pi

Type: task
Status: open
Blocked by: 21, 22

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
