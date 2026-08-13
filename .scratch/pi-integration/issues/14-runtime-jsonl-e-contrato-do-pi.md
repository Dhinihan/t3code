# Runtime JSONL e contrato de compatibilidade do Pi

Type: task
Status: open
Blocked by: —

## Pergunta

Implementar a fronteira de processo/protocolo que permita ao server conversar
com `pi --mode rpc` sem ainda montar o adapter completo:

- processo filho scoped com stdin/stdout JSONL e stderr separado;
- framing LF, IDs de correlação e intercalação segura de respostas/eventos;
- schemas tolerantes a campos/tipos novos e estritos nos requisitos consumidos;
- comandos mínimos compartilhados por probe e sessão (`get_state`, modelos,
  thinking, prompt, abort e shutdown);
- piso semver `0.84.1` e handshake sintético tipado conforme a decisão de
  **Handshake RPC e política de incompatibilidade**;
- encerramento limpo, timeout, EOF, morte inesperada e ausência de processo
  órfão.

Construir junto a parte aplicável da **Suíte do adapter Pi e detecção de drift
do Pi**: testes puros do contrato, fixture de fio curada e peer JSONL scriptado
que exercite o runtime de produção sem Pi instalado. Este ticket termina com o
runtime reutilizável e hermeticamente testado; snapshot, sessões T3 e mapeamento
canônico de eventos ficam nos tickets seguintes.
