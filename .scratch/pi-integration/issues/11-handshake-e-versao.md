# Handshake RPC e política de incompatibilidade

Type: grilling
Status: open
Blocked by: 01, 07

## Pergunta

O escopo exige que o handshake/versionamento RPC seja validado na inicialização e
que incompatibilidades sejam reportadas como erro de backend. O T3 não gerencia a
atualização do Pi — então o Pi _vai_ mudar debaixo desta integração, sem aviso.

Decidir:

- O que é verificado, e quando: na subida do server, na criação da instância do
  driver, ou a cada sessão?
- Qual é o critério de compatibilidade — versão exata, faixa, ou detecção por
  capabilities (mais robusto se o Pi não versionar o protocolo)?
- Como a falha se manifesta: instância indisponível (o T3 já tem o conceito de
  _unavailable shadow snapshot_), thread que falha ao iniciar, ou aviso não
  bloqueante? Qual dá ao usuário a mensagem mais útil.
- O que acontece se o usuário atualizar o Pi **com sessões vivas**.
- Compatibilidade parcial: se o Pi ganhar eventos que o adapter não conhece, o
  padrão é ignorar e seguir, ou falhar alto? Escolher o padrão que envelhece
  melhor.

O que sair daqui vira o passo 2 do procedimento de manutenção do escopo.
