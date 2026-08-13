# Papel do Pi no serviço auxiliar de text generation

Type: grilling
Status: open
Blocked by: —

## Pergunta

O SPI `ProviderDriver` exige `textGeneration`, usado por funções auxiliares do
T3 além do turno principal. Decidir qual comportamento o driver Pi deve
oferecer no MVP sem ampliar silenciosamente a topologia escolhida:

- usar processos Pi efêmeros e um modelo scoped/default para essas chamadas;
- reutilizar alguma sessão existente sem contaminar o contexto da thread;
- delegar explicitamente a outro provider configurado do T3;
- ou declarar o serviço não suportado e manter a seleção auxiliar fora do Pi.

A resposta deve fixar modelo/seleção, isolamento de sessão, lifecycle, custo de
spawn, tratamento de erro e quais fluxos do produto precisam continuar
funcionando para alcançar o destino do mapa.
