# Montar e registrar o ProviderDriver Pi

Type: task
Status: open
Blocked by: 14, 15, 16, 17, 18, 19, 20

## Pergunta

Montar as peças já implementadas em uma instância funcional de
`ProviderDriver` e integrá-la ao fork com a menor pegada possível:

- driver/config schema e serviços `snapshot`, `adapter` e `textGeneration`;
- registro curto em `builtInDrivers.ts` e environment Effect necessário;
- instância Pi explícita em `providerInstances`, sem chave legacy nova em
  `settings.providers`;
- apresentação genérica suficiente para web/mobile selecionar a instância e
  seus modelos, usando fallbacks existentes onde ícone/polimento não forem
  obrigatórios;
- providers nativos preservados e nenhuma alteração desnecessária nos arquivos
  quentes identificados em **Anatomia de um driver T3 e a pegada de um
  `ProviderDriverKind` novo**.

Rodar os testes focados de server/contracts/clients e comprovar que o server
isolado publica o snapshot Pi pronto sem quebrar os providers existentes.
