# APK de desenvolvimento conectado ao host pela LAN

Type: task
Status: open
Blocked by: 05

## Pergunta

O momento de aceitação deste mapa é uma mensagem saindo do celular. Provar o
caminho mobile **antes** do Pi entrar em cena isola as duas classes de falha: se
o celular já conversa com o T3 integrado usando um provider qualquer, tudo que
falhar depois é problema do Pi, não da rede.

Trabalho a fazer:

- Gerar o dev build / APK do `apps/mobile` usando os mecanismos que o projeto já
  tem (`dev:client`, perfil Android de desenvolvimento) — sem inventar
  pipeline novo.
- Apontar o endpoint para o host na LAN ou via Tailscale, preservando o fluxo
  nativo de conexão do T3: só o endereço muda.
- Parear com o **ambiente isolado** do ticket `05`, não com o T3 vanilla.
- Provar com uma thread real ponta a ponta em qualquer provider já existente.

Sem T3 Connect, relay ou serviço hospedado em nenhum ponto do caminho.

Resolvido quando o celular conversa com o T3 integrado. A resposta deve
registrar: como o build foi feito, o endereço/forma de conexão, e as pegadinhas
encontradas (firewall, HTTPS, descoberta, expiração de pareamento).
