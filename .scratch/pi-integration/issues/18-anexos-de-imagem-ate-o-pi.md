# Encaminhar anexos de imagem do T3 ao Pi

Type: task
Status: resolved
Blocked by: 14, 16, 17

## Pergunta

Conectar o pipeline existente de `ChatAttachment` ao campo `images` dos
comandos RPC do Pi:

- reutilizar a resolução/validação de anexos do server, sem infraestrutura
  paralela;
- converter imagens suportadas para `{ type: "image", data: base64, mimeType }`;
- preservar MIME e conteúdo, limites existentes e ordem junto ao texto;
- rejeitar anexos não-imagem, conteúdo ausente ou modelo sem input de imagem com
  erro de backend legível, mantendo a thread recuperável;
- não incluir geração, edição ou resultados próprios de imagem.

Cobrir conversão, múltiplas imagens, MIME inválido, limites, prompt somente com
imagem e erro do Pi. Provar que o adapter envia a forma observada em **Superfície
do RPC headless do Pi**.

## Answer

Implementado o encaminhamento de anexos de imagem no adapter Pi.

- `PiImageAttachments.ts` reutiliza `resolveAttachmentPath` e o schema/limites
  existentes, lê os bytes sequencialmente, rejeita tipo/MIME/conteúdo/path
  inválidos e produz `{ type: "image", data, mimeType }`, preservando ordem e
  MIME.
- O contrato `prompt` do Pi agora aceita `images`. `PiAdapter` permite prompt
  somente com imagem, consulta `get_state.model.input` depois da troca de
  modelo e rejeita apenas quando Pi declara explicitamente ausência de
  `image`; capacidade desconhecida continua tolerada.
- Erros de leitura/capacidade acontecem antes de iniciar o turno. Erro
  retornado pelo Pi mantém a sessão recuperável e produz `turn.completed`
  falho conforme a política existente.
- `PiAdapterRuntime.test.ts` prova a forma no peer JSONL headless.

Verificações: suíte Pi focada com 8 arquivos / 59 testes passou; lint focado,
formatação e `git diff --check` passaram. `pnpm exec vp run --filter t3
typecheck` não encontrou erros nos arquivos alterados; mostrou apenas sugestões
preexistentes fora deste ticket.
