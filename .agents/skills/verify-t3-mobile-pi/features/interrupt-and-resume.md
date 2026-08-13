# Receita: interromper e retomar

Use esta receita quando a tarefa pedir o controle de interrupção, a continuidade na mesma thread ou a inspeção de processos órfãos.

## How to get to it (user POV)

- Enviar uma mensagem pelo composer de uma thread existente.
- Tocar o controle vermelho de parar enquanto o Pi trabalha.
- Usar o mesmo composer depois que a thread mostrar o estado interrompido.

## Driving it with adb + uiautomator

Preconditions:

- Uma thread pareada está pronta para receber um turno bloqueante; continue a atual quando a tarefa pedir continuidade ou abra uma nova para isolamento.
- O host permite observar processos com `ps`; os PIDs do backend/Metro estão no `state.env`.

- **Bloquear.** Envie uma instrução para executar `bash -lc 'tail -f /dev/null'` sem encerrar o turno. A árvore mostra `Working for ...` e o controle vermelho de parar.
- **Interromper.** Localize o botão de stop pela árvore/screenshot atual e acione-o. Não mate um processo por nome no host. O celular deve mostrar o turno encerrado/interrompido.
- **Confirmar lifecycle.** Se a tarefa precisar de prova persistida, rode `helpers/verify-mobile-pi.sh db-proof`; use a linha do turno para verificar o estado `interrupted` e confirme que o Pi não continua emitindo eventos para aquela rodada.
- **Retomar.** Envie uma nova mensagem curta pedindo a resposta literal `RESUME-OK` pelo `Send`. A resposta chega na mesma thread e o novo turno termina normalmente.
- **Registrar processos.** Se a tarefa precisar dessa evidência, capture `interrupt-resume-final`, rode `ps -eo pid=,ppid=,args=` e confira os processos Pi iniciados pelo run antes e depois de `cleanup`. O cleanup só deve encerrar PIDs registrados pelo helper.

## Gotchas

- O clique de stop é uma ação de usuário; enviar o RPC `abort` por fora não prova o caminho mobile.
- Só conte `interrupted` depois de o turno persistido mudar; o botão desaparecer não é suficiente.
- O retry deve reutilizar o mesmo `thread_id`; criar uma thread nova esconde a falha de continuidade.
- O cleanup só pode encerrar PIDs registrados pelo helper; processos encontrados por busca devem ser investigados, não mortos às cegas.
