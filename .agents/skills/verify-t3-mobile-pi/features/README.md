# Receitas de execução: T3 Code Mobile com Pi

Estas são receitas opcionais para dirigir cenários específicos no Android. Escolha somente a receita pedida pela tarefa; o arquivo não é uma suíte obrigatória.

## Baseline

- Inicie o run com `helpers/verify-mobile-pi.sh launch`; ele faz bootstrap/reuso do SDK, ADB e AVD em cache, e valide a instância com `doctor`.
- O primeiro run pode baixar a ferramenta e a system image; runs seguintes reutilizam `ANDROID_RUNTIME_CACHE` e mantêm o runtime instalado.
- Depois do launch, faça `source <state-file>` e `export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"` antes das ações `adb` descritas nas receitas.
- Use apenas o `ADB_SERIAL` escolhido para este run e o `BASE_DIR` impresso pelo helper.
- O origin informado ao app Android é `MOBILE_ORIGIN`, normalmente `http://10.0.2.2:<server-port>`.
- Crie um pairing token novo para cada tentativa; tokens são únicos e não entram em evidência.
- Escolha uma thread nova ou existente conforme a receita solicitada.
- Capture somente as telas, estados ou processos necessários para a receita escolhida.

## Receitas

- [Parear e selecionar o Pi](./pair-and-select-pi.md) — ações para abrir conexões, parear e navegar até a seleção de modelo.
- [Enviar texto e imagem](./text-and-image.md) — ações para preparar um anexo, usar o picker e enviar pelo composer.
- [Tools e MCP do Pi principal](./tools-and-mcp.md) — ações para solicitar tools e observar os processos envolvidos.
- [Interromper e retomar](./interrupt-and-resume.md) — ações para iniciar um turno bloqueante, interromper e continuar a thread.
