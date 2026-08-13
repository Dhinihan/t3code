# Mapa de verificação: T3 Code Mobile com Pi

Este mapa descreve a aceitação do usuário final no Android: o APK de desenvolvimento se conecta a um T3 isolado, seleciona um modelo Pi scoped e mantém uma thread funcional do primeiro envio ao retry após interrupção.

## Baseline

- Inicie o run com `helpers/verify-mobile-pi.sh launch` e valide com `doctor`.
- Use apenas o `ADB_SERIAL` escolhido para este run e o `BASE_DIR` impresso pelo helper.
- O origin informado ao app Android é `MOBILE_ORIGIN`, normalmente `http://10.0.2.2:<server-port>`.
- Crie um pairing token novo para cada tentativa; tokens são únicos e não entram em evidência.
- Comece cada feature numa thread nova, salvo quando a própria feature disser que continua a thread anterior.
- Cada prova combina uma ação observável no app, screenshot/árvore e uma confirmação do estado persistido ou dos processos.

## Features

- [Parear e selecionar o Pi](./pair-and-select-pi.md) cobre a entrada no app, o ambiente isolado e o modelo scoped.
- [Enviar texto e imagem](./text-and-image.md) cobre o caminho de usuário até uma única resposta do Pi com anexo persistido.
- [Tools e MCP do Pi principal](./tools-and-mcp.md) cobre subagentes como tools genéricas e o limite do MCP nativo do T3.
- [Interromper e retomar](./interrupt-and-resume.md) cobre o lifecycle do turno, o retry na mesma thread e ausência de órfãos.
