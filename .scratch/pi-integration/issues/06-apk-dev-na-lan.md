# APK de desenvolvimento conectado ao host pela LAN

Type: task
Status: resolved
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

## Comments

### 2026-08-12 — tentativa de execução

O caminho do backend foi provado, mas a aceitação mobile não foi possível neste
host:

- As dependências foram restauradas com `pnpm install --frozen-lockfile`.
- O projeto `T3 Code Pi integration 06` foi cadastrado no banco do ambiente
  isolado de `05` (`/home/vinicius/workspace/t3-com-pi/.t3/pi-integration-05`).
- O servidor subiu e respondeu HTTP 200 ao descriptor com
  `T3CODE_PORT_OFFSET=500 pnpm exec vp run dev --home-dir ... --host 0.0.0.0
--port 14273`.
- O endereço para conexão direta é `http://192.168.1.107:14273` pela LAN ou
  `http://100.82.138.77:14273` pelo Tailscale. O mesmo `environmentId` foi
  retornado nos três probes (`127.0.0.1`, LAN e Tailscale), confirmando que não
  eram ambientes diferentes.
- `APP_VARIANT=development pnpm exec expo config --json` confirmou o dev
  client `T3 Code Dev`, pacote `com.t3tools.t3code.dev` e esquema
  `t3code-dev`.
- O perfil existente para gerar o APK é `eas build --profile development -p
android`, mas o host não tem login EAS nem `EXPO_TOKEN`; `eas-cli whoami`
  retornou `Not logged in`.
- Também não há Android SDK, `adb`, emulador ou APK compatível neste host.

O servidor iniciado para a prova foi encerrado pelo mesmo terminal; o ambiente
isolado e o projeto cadastrado foram preservados para a continuação. Falta um
login/token EAS e um aparelho/emulador Android para gerar/instalar o dev client,
parear com um token novo e enviar a thread real. Nenhum token de pareamento foi
registrado neste arquivo.

### 2026-08-12 — build EAS concluído

O login EAS foi confirmado para a conta pessoal `dhinihan` e o projeto foi
vinculado a `@dhinihan/t3-code` (ID `440f643b-ed3a-4cfb-a052-2dd7e69fb4b4`).
Como o projeto anterior da organização `pingdotgg` não era acessível, o
`apps/mobile/app.config.ts` passou a apontar para esse projeto pessoal, sem
alterar o pipeline nativo.

- O build autorizado foi executado com `eas build --profile development
--platform android --wait`, build ID
  `0dc63813-60a5-4c88-9992-b694d9dbb8bb`, e terminou em `FINISHED`.
- A nova keystore Android remota foi criada com autorização explícita; o
  upload do projeto (159 MB) e o download do APK (305 MB) terminaram com
  sucesso. O APK foi mantido apenas em `/tmp/t3-pi-06-apk/` e não entra no
  repositório.
- O APK confirma um dev client instalável, mas a instalação e a thread real
  ponta a ponta continuam bloqueadas neste host: `adb` e `emulator` não estão
  instalados e não há dispositivo Android conectado. O backend/LAN do
  comentário anterior também estava desligado ao finalizar esta tentativa.

Não foi gerado novo token de pareamento nem registrado qualquer segredo neste
arquivo. Para concluir a aceitação, retomar com um aparelho/emulador Android,
subir novamente o ambiente isolado de `05`, criar um pareamento temporário e
provar uma thread real pelo endpoint LAN/Tailscale.

### 2026-08-12 — aceitação mobile concluída

Com o APK instalado no aparelho, o usuário carregou o bundle pelo Metro usando
`exp://192.168.1.107:8081`, pareou o app com o ambiente isolado usando
`http://192.168.1.107:14273` e criou uma thread real com sucesso.

Durante a prova, o UFW foi liberado pelo usuário somente para a LAN nas portas
`8081/tcp` (Metro) e `14273/tcp` (backend). O primeiro credential falhou por
expiração/uso único; um novo token temporário resolveu o pareamento. Nenhum
token foi registrado neste arquivo.

## Answer

O dev build Android foi gerado pelo perfil EAS `development`, o app conectou
ao T3 integrado pela LAN e a criação de uma thread real no celular foi
confirmada. Backend e Metro permanecem ativos para a continuidade da validação
manual.
