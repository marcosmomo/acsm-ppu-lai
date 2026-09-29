# HCM Node-RED Integration

## Onde a HCM e chamada

O flow `node-red/supply-chain-coordinator-flow.json` possui uma ramificacao isolada chamada
`HCM Collective Memory Sync - prepare episode`.

Ela esta conectada ao no `Store Level 3 package and decision`, depois que o Supply Chain
Coordinator normaliza o pacote `supplychain/reasoning` e gera a decisao semantica.

A logica principal do Coordinator e os publishers MQTT existentes nao sao alterados. A HCM roda
em modo best-effort: se a API falhar, o flow principal continua.

## Configuracao

A URL base da HCM e resolvida nesta ordem:

1. `HCM_API_BASE_URL` via env var do Node-RED
2. `process.env.HCM_API_BASE_URL`
3. `http://localhost:3000/api/hcm`

Valor esperado:

```text
HCM_API_BASE_URL=http://localhost:3000/api/hcm
```

## Endpoints usados

Sequencia principal:

1. `POST /api/hcm/episode/open`
2. `POST /api/hcm/event`
3. `POST /api/hcm/decision`
4. `POST /api/hcm/effectiveness`, apenas quando houver OEE anterior suficiente no historico de feedback

## Payloads enviados

### Abrir episodio

O Node-RED envia:

```json
{
  "trigger": "coordinator_recommendation",
  "criticalACSM": "acsm1",
  "globalOEE": 0.72,
  "targetOEE": 0.85,
  "corporateGoal": { "targetOEE": 0.85 },
  "risk": "high",
  "bottleneck": "cps7",
  "recommendation": "Coordinator recommendation",
  "contextSnapshot": {
    "global": {},
    "acsm1": {},
    "acsm2": {},
    "acsm3": {},
    "coordinatorOutput": {},
    "knowledge": {}
  }
}
```

### Eventos

Sao enviados quatro eventos por episodio:

- `state_update` para `acsm1`
- `state_update` para `acsm2`
- `state_update` para `acsm3`
- `recommendation` para `coordinator`

### Decisao

O Node-RED envia:

```json
{
  "episodeId": "<episodeId>",
  "decisionSource": "supply_chain_coordinator",
  "targetACSM": "acsm1",
  "strategy": "reconfigure_supply_plan",
  "recommendation": "Coordinator recommendation",
  "rationale": "Decision justification",
  "expectedGain": 0.03
}
```

### Efetividade opcional

Quando o historico `supplychain_feedback_history` tem um OEE anterior e o output atual tem
`globalOEE`, o flow envia:

```json
{
  "episodeId": "<episodeId>",
  "beforeGlobalOEE": 0.70,
  "afterGlobalOEE": 0.72,
  "targetACSM": "acsm1",
  "beforeTargetOEE": 0.85,
  "afterTargetOEE": 0.85,
  "notes": "Effectiveness calculated from Node-RED coordinator feedback"
}
```

## Deduplicacao

O flow evita duplicacao do mesmo output usando uma assinatura estavel com:

- `criticalACSM`
- `trigger`
- `recommendation`
- `rationale`
- `globalOEE` arredondado
- `targetOEE` arredondado

Quando a assinatura e repetida, o Node-RED registra:

```text
[HCM NODE-RED] skipped duplicate signature
```

## Logs

Os logs principais sao:

```text
[HCM NODE-RED] open episode request
[HCM NODE-RED] open episode response
[HCM NODE-RED] event request
[HCM NODE-RED] decision request
[HCM NODE-RED] effectiveness request
[HCM NODE-RED] skipped duplicate signature
[HCM NODE-RED] error
```

## Como validar

1. Inicie o Next.js em `http://localhost:3000`.
2. Inicie o Node-RED com o flow `node-red/supply-chain-coordinator-flow.json`.
3. Publique um pacote do Supply Chain Coordinator no topico MQTT `supplychain/reasoning`.
4. Verifique os logs `[HCM NODE-RED]`.
5. Abra `/analytics-system` e confira o painel `Hierarchical Cognitive Memory (HCM)`.
6. Verifique `data/hcm-store.json`; deve conter pelo menos um episodio em `episodes`.

Tambem e possivel validar via API:

```text
GET http://localhost:3000/api/hcm/episodes
GET http://localhost:3000/api/hcm/episodes/open
```
