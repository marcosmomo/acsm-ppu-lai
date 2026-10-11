# CPS-LAI-03 diagnostic evidence

This directory is reserved for append-only evidence produced by the disabled-by-default Node-RED flow `CPS-LAI-03 | Sensor Validation`.

- `opcua-readings.jsonl`: one JSON object per successful or failed OPC UA read while supervised collection is enabled.
- `sensor-validation.jsonl`: explicit supervised physical observations only. An OPC UA response never validates a sensor automatically.

The JSONL files are created by Node-RED on their first accepted record. Existing files are appended to and must not be overwritten.

Before copying evidence, stop collection in the flow. Copy the files to a new timestamped evidence directory; do not move, truncate, rename, or edit the originals while Node-RED is running.
