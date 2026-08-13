# Topologia de processo e ciclo de vida do Pi

Type: grilling
Status: resolved
Blocked by: 01, 04, 07

## Pergunta

Quantos processos Pi existem, e quem os possui?

As opções não são equivalentes, e a escolha contamina persistência, isolamento e
recuperação de falha:

- **Um processo por thread T3**, vivo enquanto a thread estiver ativa.
- **Um processo por turno**, subindo e morrendo a cada mensagem.
- **Um daemon Pi compartilhado**, multiplexando sessões.

Decidir, e junto com isso:

- Onde o processo vive no modelo de scope do Effect — o `create` do driver possui
  o processo, e fechar o scope deve liberá-lo. Como isso conversa com o reaper de
  sessões que o T3 já tem?
- O que acontece quando o server T3 reinicia com processos Pi vivos.
- Como a exigência do escopo — "falhas devem deixar a thread recuperável, sem
  processos órfãos ou estado permanentemente em execução" — é garantida, e como
  ela é _testada_.
- Custo de startup: se subir o Pi é caro (carregar extensões, catálogo de
  modelos), processo-por-turno pode ser inviável na prática. O ticket `07` deve
  ter medido isso.

## Answer

Cada thread T3 possui uma sessão Pi persistente e exclusiva, mas não um processo
permanente. O processo Pi é criado sob demanda quando a thread precisa executar
um turno, permanece associado à sessão enquanto há atividade e é encerrado pelo
reaper após inatividade.

O processo é recurso do scope da sessão ativa: fechar o scope deve encerrar o
filho e aguardar sua saída. Reiniciar o servidor não tenta adotar processos
antigos; o processo anterior termina com seu owner e um novo processo retoma a
sessão persistida quando a thread voltar a ser usada. Assim, processo é estado
efêmero de execução, enquanto o histórico da sessão Pi sobrevive a reaping,
crash e restart.

Essa topologia evita o custo de subir um processo a cada turno, não introduz um
daemon compartilhado nem multiplexação entre threads e mantém a recuperação
testável: uma thread reapada ou interrompida deve poder iniciar outro processo
com a mesma sessão, sem processo órfão nem estado de execução preso.
