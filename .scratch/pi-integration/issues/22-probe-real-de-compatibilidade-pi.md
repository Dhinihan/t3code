# Probe real de compatibilidade contra o Pi instalado

Type: task
Status: open
Blocked by: 14, 15, 16, 17, 18

## Pergunta

Transformar o procedimento decidido em **Suíte do adapter Pi e detecção de
drift do Pi** num comando permanente de manutenção, separado do runner normal:

- executar `pi --version` e aplicar o piso aceito;
- iniciar o Pi real em diretórios de sessão temporários e isolados;
- validar handshake, catálogo scoped, thinking, turno de texto, ferramenta,
  abort, encerramento e retomada;
- passar respostas/eventos pelos decodificadores de produção;
- destacar campos e eventos novos para inspeção, mas falhar somente em requisito
  ausente ou forma incompatível;
- não regravar fixtures automaticamente, não vazar segredos e limpar todos os
  processos/arquivos temporários.

Documentar o comando no procedimento “atualizou o Pi → probe real → investigar
→ suíte hermética”. Ele pode exigir instalação, autenticação e chamadas reais
do Pi, mas não roda em CI nem sob `vp test run`.
