# CPS-LAI-03 experimental signal metrics

These metrics are experimental signal evidence only. They are not completed-cycle, good/rejected-piece, availability, performance, quality, or OEE values.

The operational adapter reads `B1BG1`, `G1BG3`, `G1MB1`, and `G1MB2` through the existing OPC UA READ client also used for the mode markers. It publishes only to the separate topic `cpslai3/experimental-metrics`.

## MQTT JSON contract

`schemaVersion: "1.0"` payload fields:

- `cpsId`, `metricSessionId`, `sessionStatus`, `startedAt`, `updatedAt`;
- `source: "CPS_LAI_03_EXPERIMENTAL_SIGNAL_AGGREGATOR"`, `evidenceOrigin: "OPC_UA_READ"`, `evidenceQuality`, `maxSampleGapMs`;
- `metrics.pieceSensorActivationCount`: rising Boolean edges (`false → true`) on B1BG1;
- `metrics.conveyorSignalActiveTimeMs`: only intervals bounded by consecutive valid G1BG3 samples that are both true;
- `metrics.separator1ActivationCount` / `separator2ActivationCount`: rising Boolean edges on G1MB1 / G1MB2;
- `measuredSignals[]`: tag, NodeId, value, actual datatype evidence, StatusCode/quality, local collection time and OPC UA timestamps;
- `lastEvent`: most recent observed edge event; `interpretation.oee` is always `NOT_COMPUTED`.

All four samples must form a complete batch and pass explicit Boolean datatype, Good StatusCode, local freshness and maximum-gap checks (default 6000 ms; flow context `cpslai3_exp_max_gap_ms`). A session's first batch and the first batch after an acquisition timeout only establish a baseline. OPC UA source/server timestamps are preserved but not used as freshness clocks because existing diagnostic logs contain 2014 timestamps; local `collectedAt` and consecutive acquisition spacing provide the freshness evidence.

## Session controls

- **Start experimental metrics session (manual)** starts a fresh ID and zeroes the experimental counters.
- **Reset experimental metrics (new session)** starts a new ID and resets counters without interacting with the PLC.
- **Stop experimental metrics session** prevents further aggregation.
- A one-shot startup/deploy reset interrupts any prior running session and clears its baseline, preventing artificial edges after runtime restart. The operator must manually start a session again.

No control emits OPC UA WRITE/CALL. A Good read does not validate production semantics. Before enabling/deploying the flow at the LAI, verify that the installed OPC UA node returns the four values with an explicit Boolean datatype attribute. Keep `cpslai3/oee` at `NOT_COMPUTED` until independent production evidence and experimental parameters are validated.

## OEE alignment and current limits

The official CPS-LAI-01 Node-RED adapter reserves `cpslai1/oee` but leaves it unwired; its LAI runtime README likewise says OEE is not published without real evidence. A separate `services/cps1/src/oee.js` contains an OEE implementation for the simulated welding example, not CPS-LAI-01. That implementation starts its in-memory accumulator when the service starts, accrues planned time while `playEnabled === true`, accrues operating time unless the current telemetry says `OperationMode === "stop"`, and counts `PieceCounter` deltas. It assigns each new count to good or reject using `WeldDefectDetected` on that sample. Its ideal cycle is a hard-coded 1,800 ms. Availability is operating/planned time; Performance is `min(1, idealCycleMs × cumulative pieces / operating time)`; Quality is good/total (defaulting to 1 when no pieces); OEE is their product. The accumulator is in memory; each result is persisted to runtime state and published on each simulated telemetry tick. Those welding-specific input assumptions and its 1,800 ms constant are not reused for CPS-LAI-03.

CPS-LAI-03 keeps the existing `cpslai3/oee` topic and fraction-valued ACSM contract, but its OEE window is now the same explicit Start/Stop experimental session used by the signal aggregator (`windowId === metricSessionId`). The window timestamps are metadata only; they do not imply planned production time. A new session resets the experiment; a Node-RED runtime restart interrupts it, consistent with the existing in-memory experimental counters. The former manual OEE-window injection path has been removed so arbitrary operator-entered counts or time values cannot activate the calculation.

For the current signals, the corresponding CPS1 inputs cannot be established:

- B1BG1's four rising edges are experimentally observed piece-entry events, not the CPS1 `PieceCounter` of completed cycles.
- G1BG3 active time is only signal-high time; its movement semantics are not validated, it remained false in this trial, and it is not planned production time.
- G1MB1/G1MB2 activations are separator events, not a validated reject/good result. No `WeldDefectDetected` equivalent exists.
- No LAI-03 ideal-cycle parameter is defined.

Therefore the adapter publishes all four OEE values as `null`, each component as `NOT_COMPUTED`, and an explicit list of missing production inputs. The experimental counts remain attached as evidence, not as OEE components. This behavior is not a new OEE method; it preserves the existing OEE contract and formulas as unavailable until CPS-LAI-03 supplies semantically equivalent evidence. ACSM's existing Play Phase continues to label the panel **Experimental OEE**.
