# CPS-LAI-01 Operational Emulator (legacy filename)

This flow is now the operational substitute producer for CPS-LAI-01. See `CPS-LAI-01-OPERATIONAL-EMULATOR.md` for the current broker, contracts, producer-conflict check, tests, and controlled activation procedure.

> The material below is retained only as historical documentation of the former isolated DEMO design. Do not follow its broker 1884 or `synthetic/cpslai1/*` instructions.

## Isolation and controls

The imported tab is disabled by default. It publishes only to the separate loopback broker at `127.0.0.1:1884`; the browser dashboard connects over `ws://127.0.0.1:9002/mqtt`. The four topics are `synthetic/cpslai1/data`, `synthetic/cpslai1/status`, `synthetic/cpslai1/oee`, and `synthetic/cpslai1/events`. Every publication also goes to a Debug node. The broker config does not auto-connect, and the broker service is not part of the default operational compose file. The flow does not use OPC UA, the PLC, the operational broker, persistence, HCM, email, or PPU commands. All state uses `cpslai1_synthetic_*` flow-context keys.

Enable the tab manually in the Node-RED editor only for a local controlled session. Click one `START / RESTART` Inject node to reset state and start its scenario. Click `STOP` to end it. Clicking a scenario button while running restarts with a clean synthetic baseline. The repeating 250 ms clock has `once=false`, and the tab is disabled, so importing the flow does not begin an experiment.

## Signals

| Tag | Normalized field | Emulation |
| --- | --- | --- |
| G1BG1 | PieceAtExit | Boolean piece exit sensor |
| G1BG2 | PieceAtMiddle | Boolean middle sensor |
| G1BG3 | PieceAtEntry | Boolean entry sensor |
| C2BG1 | SlideRetracted | Boolean slide position |
| C2BG2 | SlideExtended | Boolean slide position |
| ALARMS | AlarmSignal | Boolean alarm marker |
| sys_man | ManualModeSignal | Manual mode marker |
| man_step_1 | StepByStepModeSignal | Step by step / maintenance marker |
| sup_step_1 | AutomaticModeSignal | Automatic mode marker |
| GCT_0 | InitModeSignal | Initialization marker used during return |

Each generated signal resembles an OPC UA message (`topic` is the NodeId, `payload` is Boolean, and `statusCode.value` is zero), then passes through the isolated normalization and rising-edge metric logic. The copied OEE expressions remain Availability = runtime / planned time, Performance = min(1, 2020 ms × totalCount / runtime), Quality = 1.0 when totalCount > 0, and OEE = Availability × Performance × Quality. Quality remains the prototype's assumed-conforming-output proxy.

## Scenarios

The declarative scenario parameters are in `config/cps-lai-01-synthetic-scenarios.json`. The Node-RED generator carries the same runtime values so it remains self-contained when imported. `normal` cycles at 3 s; `degradation` cycles at 6.5 s; `stop` completes one cycle then holds physical sensors steady; `alarm` raises ALARMS; `incomplete` produces Entry then Exit without Middle; `maintenance` holds `man_step_1`; `return` uses GCT_0 for 3 s and then resumes automatic play; `communicationLoss` ceases signal messages after 1 s, allowing the 5 s freshness rule to report UNKNOWN.

## Controlled import and integration

1. Review the flow, isolated broker configuration, and test artifacts.
2. Start only the experimental broker when ready: `docker compose -f node-red/lai/compose.synthetic-broker.yml up -d`. It binds both ports to loopback; it does not join the operational Docker network.
3. In the intended local Node-RED instance, import `node-red/lai/flows/cps-lai-01-synthetic-emulator.json`. Confirm the tab is disabled, the broker node targets `127.0.0.1:1884`, and all four MQTT Out nodes reference that broker.
4. Historical step removed: the ACSM Analytics DEMO controls and isolated subscription no longer exist. Follow `CPS-LAI-01-OPERATIONAL-EMULATOR.md` instead.
5. Stop the broker after the demonstration: `docker compose -f node-red/lai/compose.synthetic-broker.yml down`. Disable the Node-RED tab. No synthetic record is suitable as physical history, MySQL data, an HCM event, a PPU fact, or a governance input.

Run the static behavior and isolation checks with:

```powershell
node --test test/cps-lai-01-synthetic-isolation.test.mjs
```

The tests execute embedded Function-node code and the dashboard bridge against in-memory contexts and mock clients. They do not start Node-RED or Mosquitto, publish to a broker, or connect to a PLC.
