# CPS-LAI-01 runtime adapter

> **Inactive alternative:** this Node.js runtime is retained only as an architectural reference and is not part of the principal Docker Compose deployment. The definitive physical integration uses the importable Node-RED adapter under `node-red/lai`. Do not start this runtime while the Node-RED adapter is publishing `cpslai1/#`; simultaneous publishers are unsupported.

Node.js integration service for the physical LAI distribution/conveyor station. It exposes the AAS and technical state over REST, connects to the ACSM MQTT broker, and optionally bridges confirmed OPC UA fields from the Siemens S7-1500 PLC.

## Safe startup

The service intentionally starts when `OPCUA_ENDPOINT` and the physical NodeIds are not configured. In that state it reports:

- `lifecycleState: plugged`
- `operationalState: offline`
- `availability: unavailable`
- `healthState: unknown`
- `integrationState: awaiting_field_configuration`

It does not generate telemetry, OEE, learning, reasoning, or recommendation payloads. Commands receive a negative `FIELD_CONFIGURATION_REQUIRED` acknowledgement until their physical binding is confirmed.

## Configuration

Copy `.env.example` only for local execution. Never commit PLC credentials. Replace `FIELD_CONFIRMATION_REQUIRED` in a deployment-specific field mapping after the NodeIds have been confirmed at the LAI.

The compose service mounts the canonical repository AAS from `cps-defs/aas-cps-lai-01-acsm-runtime-v1.0.json` as `/app/aas/aas.json`; the AAS is not duplicated in this service.

## REST API

- `GET /health`
- `GET /api/cpslai1/health`
- `GET /api/cpslai1/description`
- `GET /api/cpslai1/summary`
- `GET /api/cpslai1/aas`
- `GET /api/cpslai1/data`

## MQTT

The adapter subscribes to `cpslai1/cmd` and publishes acknowledgements and technical state to `cpslai1/ack`, `cpslai1/status`, and `cpslai1/health`. `cpslai1/data` and `cpslai1/sensordata` are published only after actual OPC UA values are received. `cpslai1/oee` and the cognitive topics are reserved and are not published without sufficient real data.

## Docker

From the repository root:

```powershell
docker network inspect acsm-network *> $null; if ($LASTEXITCODE -ne 0) { docker network create acsm-network }
docker volume inspect cps1-data *> $null; if ($LASTEXITCODE -ne 0) { docker volume create cps1-data }
docker volume inspect cps5-data *> $null; if ($LASTEXITCODE -ne 0) { docker volume create cps5-data }
docker volume inspect cps7-data *> $null; if ($LASTEXITCODE -ne 0) { docker volume create cps7-data }
docker compose config
docker compose build cps-lai-01
docker compose up -d acsm-mosquitto cps-lai-01
docker compose ps cps-lai-01
Invoke-RestMethod http://localhost:3010/health
```

Use a deployment-only mapping file or override the compose mount before connecting to the physical PLC. Configure security mode, policy, and credentials according to the PLC's confirmed OPC UA server configuration.
