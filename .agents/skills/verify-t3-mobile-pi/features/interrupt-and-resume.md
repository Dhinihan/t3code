# Interromper e retomar

O usuário consegue interromper um turno bloqueante pelo celular, vê o turno terminar como `interrupted`, continua na mesma thread e não deixa o processo Pi nem um filho pendurado no host.

## Sub-features

- `blocked-turn` — inicia um comando bloqueante observável.
- `mobile-abort` — usa o controle de interrupção da thread mobile.
- `interrupted-state` — persiste o turno como `interrupted`.
- `same-thread-resume` — uma nova mensagem responde `RESUME-OK` na mesma thread.
- `no-orphan` — não sobra `pi --mode rpc` nem filho do teste após o settle.

## How to get to it (user POV)

- Enviar uma mensagem pelo composer de uma thread existente.
- Tocar o controle vermelho de parar enquanto o Pi trabalha.
- Usar o mesmo composer depois que a thread mostrar o estado interrompido.

## Driving it with adb + uiautomator

Preconditions:

- A thread já contém a resposta `WAYFINDER` e as provas de tools, ou foi iniciada para este fluxo.
- O host permite observar processos com `ps`; os PIDs do backend/Metro estão no `state.env`.

- **Bloquear.** Envie uma instrução para executar `bash -lc 'tail -f /dev/null'` sem encerrar o turno. A árvore mostra `Working for ...` e o controle vermelho de parar.
- **Interromper.** Localize o botão de stop pela árvore/screenshot atual e acione-o. Não mate um processo por nome no host. O celular deve mostrar o turno encerrado/interrompido.
- **Confirmar lifecycle.** Rode `helpers/verify-mobile-pi.sh db-proof`; a linha do turno deve estar em estado `interrupted` e o Pi não deve continuar emitindo eventos para aquela rodada.
- **Retomar.** Envie uma nova mensagem curta pedindo a resposta literal `RESUME-OK` pelo `Send`. A resposta chega na mesma thread e o novo turno termina normalmente.
- **Provar ausência de órfãos.** Capture `interrupt-resume-final`, rode `ps -eo pid=,ppid=,args=` e confirme que não há processo Pi iniciado pelo run além do que o backend administra antes do cleanup. Depois rode `cleanup` e repita o check.

## Gotchas

- O clique de stop é uma ação de usuário; enviar o RPC `abort` por fora não prova o caminho mobile.
- Só conte `interrupted` depois de o turno persistido mudar; o botão desaparecer não é suficiente.
- O retry deve reutilizar o mesmo `thread_id`; criar uma thread nova esconde a falha de continuidade.
- O cleanup só pode encerrar PIDs registrados pelo helper; processos encontrados por busca devem ser investigados, não mortos às cegas.
