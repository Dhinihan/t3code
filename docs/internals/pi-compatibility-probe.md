# Probe de compatibilidade do Pi

O probe real é uma ferramenta manual de manutenção. Ele responde se o Pi
instalado ainda fala a forma que o adapter aceita; a suíte hermética responde
se o código do T3 continua correto contra essa forma aceita.

## Procedimento de atualização

Depois de atualizar o Pi:

1. execute `pnpm probe:pi` neste checkout;
2. investigue qualquer entrada em `Novelty`/`novelties` — campos e tipos de
   evento novos são informativos e não reprovam o probe;
3. trate como incompatibilidade a ausência de `data.sessionId`, uma resposta
   fora do envelope, uma versão abaixo de `0.84.1` ou um cenário obrigatório
   que não puder ser validado;
4. adapte conscientemente o contrato/adapter quando a novidade for relevante;
5. rode a suíte hermética focada (`pnpm exec vp test run
apps/server/src/provider/Layers/Pi*.test.ts`);
6. somente depois de aceitar a nova forma, atualize manualmente a fixture
   curada em `apps/server/src/provider/testFixtures/piRpcWire.json`, se ela
   precisar representar o novo contrato.

O probe não roda sob `vp test run`, não é executado em CI e nunca regrava
fixtures.

## Uso

```bash
pnpm probe:pi
pnpm probe:pi -- --cwd /caminho/do/projeto --model openai-codex/gpt-5.6-luna
pnpm probe:pi -- --thinking xhigh --json
```

Ele executa `pi --version`, aplica o piso de versão, e então usa o runtime e os
decodificadores de produção para validar, em diretórios de sessão temporários:

- handshake `get_state` e identidade da sessão;
- catálogo scoped pela extensão-ponte, com fallback do catálogo disponível;
- catálogo de thinking e seleção de modelo/thinking;
- turno de texto, turno com a ferramenta `read` e interrupção por `abort`;
- encerramento do processo e reabertura da mesma sessão.

As chamadas de texto e ferramenta podem usar autenticação, rede e créditos da
configuração local do Pi. O relatório contém somente versão, nomes de cenários,
tipos de erro estáveis e caminhos de campos/eventos novos; não imprime prompt,
resposta, stderr, cabeçalhos ou valores de payload. O diretório de sessão e o
arquivo marcador da ferramenta são removidos ao fim da execução, inclusive
quando um cenário falha.

Se o Pi não estiver instalado, não estiver autenticado ou uma chamada real não
puder ser concluída, o relatório falha de forma legível para a manutenção. Isso
não promove a captura para fixture e não altera o estado persistido do Pi: o
probe sempre fornece `--session-dir` temporário e um `--session-id` novo.
