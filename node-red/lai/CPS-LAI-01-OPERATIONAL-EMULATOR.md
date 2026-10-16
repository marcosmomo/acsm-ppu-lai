# Emulador operacional CPS-LAI-01

Este fluxo usa o emulador como produtor operacional substituto do `cpslai1`. Ele publica no broker principal `127.0.0.1:1883` pelos tópicos normais `cpslai1/data`, `cpslai1/status`, `cpslai1/oee` e `cpslai1/health`. Dashboard, Analytics, persistência e serviço cognitivo recebem os dados pelas integrações existentes, sem broker ou rota DEMO paralela.

## Segurança operacional

O fluxo permanece desabilitado por padrão. O relógio de 250 ms tem `once=false` e não produz mensagens até que um dos oito botões `START / RESTART` seja acionado. O fluxo não contém `mqtt in`, nós OPC UA, escrita em CLP, e-mail nem comandos PPU. A aba física `CPS-01-AdapterV2` não faz parte deste arquivo e não deve ser habilitada junto com o emulador.

Antes de habilitar, confirme a ausência de outro produtor:

```powershell
mosquitto_sub -h 127.0.0.1 -p 1883 -t "cpslai1/#" -v -W 10
```

Faça a verificação com o adaptador físico e outros simuladores conhecidos desabilitados. Qualquer mensagem observada impede a ativação até que o produtor seja identificado e parado. Como um produtor pode ser esporádico, confirme também no editor Node-RED e nos serviços implantados.

## Contratos

- `cpslai1/data`: `cpsId=cpslai1`, `source=OPC_UA`, snapshot e evidências com timestamps, qualidade, validade e origem `OPERATIONAL_EMULATOR`. `source` preserva o contrato de ingestão existente; `producerComponent` identifica o produtor real da mensagem.
- `cpslai1/status`: Operational State, Operation Mode, frescor e evidências.
- `cpslai1/oee`: Availability, Performance, Quality, OEE, tempos e métricas produtivas. As fórmulas existentes permanecem: `A = runTime / plannedTime`, `P = min(1, 2020 ms * totalCount / runTime)`, `Q = 1` quando há produção e `OEE = A * P * Q`.
- `cpslai1/health`: health operacional derivado do estado e frescor, com `healthType=OPERATIONAL_HEALTH`.

O serviço cognitivo assina `cpslai1/oee`, `cpslai1/status` e `cpslai1/data` e publica em `acsm/cpslai1/learning` um envelope com Learning, Reasoning, Prediction e Recommendation. A persistência assina os quatro tópicos operacionais. Não há rota especial para o emulador.

Os oito cenários continuam disponíveis: `normal`, `degradation`, `stop`, `alarm`, `incomplete`, `maintenance`, `return` e `communicationLoss`.

## Ativação controlada

1. Mantenha desabilitada a aba física `CPS-01-AdapterV2` e não execute comandos no CLP.
2. Inicie normalmente broker principal, ACSM-PPU-LAI, persistência e, se desejado, serviço cognitivo.
3. Verifique `cpslai1/#` como descrito acima e prossiga somente sem outro produtor.
4. Importe `flows/cps-lai-01-synthetic-emulator.json`. Confirme broker `127.0.0.1:1883`, quatro MQTT Out e aba desabilitada.
5. Habilite a aba e faça Deploy. Isso ainda não publica telemetria.
6. Acione manualmente um botão `START / RESTART`.
7. Para encerrar, acione `STOP` e desabilite a aba.

## Testes locais

```powershell
node --test test/cps-lai-01-synthetic-isolation.test.mjs
node --test services/cps-lai-01-cognitive/test/cognitive-service.test.mjs
node --test test/cps-lai-01-persistence.test.mjs test/cps-lai-01-operational-oee-ingestion.test.mjs
```

Esses testes usam contextos e clientes em memória; não publicam no broker, não acessam CLPs e não apagam bancos.
