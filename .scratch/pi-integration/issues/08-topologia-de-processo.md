# Topologia de processo e ciclo de vida do Pi

Type: grilling
Status: open
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
