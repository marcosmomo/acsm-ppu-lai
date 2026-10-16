# INT-EVO-2 — Evolution Cycle Read Model

`buildEvolutionCycleReadModel()` recebe somente projeções explicitamente injetadas e não acessa Stores, arquivos, rede ou runtime PPU.

## Estados de correlação

- `CORRELATED`: `cycleAuthority` contém `cpsId`, `plugEventId`, `plugCycleId` e `profileId`; todos os identificadores e estados fornecidos pelas demais fontes são compatíveis.
- `UNCORRELATED`: existe alguma identidade, mas falta a tupla autoritativa completa. Coincidência apenas por `cpsId` nunca promove este estado.
- `CONFLICT`: duas fontes fornecem valores diferentes para um identificador, fase lifecycle, estado do ciclo ou status de governança. O módulo expõe os candidatos e não escolhe um vencedor.
- `UNAVAILABLE`: nenhuma fonte forneceu qualquer identificador de ciclo.

Evolution ausente é sempre `NOT_AVAILABLE`; não é convertido em `BASELINE` ou `NO_CHANGE`. Uma AAS experimental permanece `operational: false`. Uma AAS alegadamente operacional exige flag operacional, `sourceId` e hash; sem isso recebe `INSUFFICIENT` e um finding.

## Contrato futuro dos cards

Plug e Play devem consumir a mesma resposta e renderizar:

- `CORRELATED`: badge positivo e os quatro identificadores.
- `UNAVAILABLE`: placeholders sem inferência.
- `UNCORRELATED`: aviso de correlação incompleta; ações não devem usar a projeção.
- `CONFLICT`: alerta bloqueante, candidatos e findings.
- `EVOLUTION_NOT_PROCESSED`: texto neutro, nunca baseline implícito.
- `DECLARED_ONLY`: capacidades documentais acompanhadas do nível de evidência.

O read model não cria nem aprova perfis e não autoriza Play.
