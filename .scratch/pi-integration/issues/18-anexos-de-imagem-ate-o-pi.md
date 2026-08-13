# Encaminhar anexos de imagem do T3 ao Pi

Type: task
Status: open
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
