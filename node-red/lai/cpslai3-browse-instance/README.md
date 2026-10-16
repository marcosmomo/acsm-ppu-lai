# Experimental CPS-LAI-03 Browse-only Node-RED userDir

This is a prepared, isolated Node-RED userDir for a future supervised
structural discovery session. It is not the operational `CPS3LAI` flow and must
not be imported into the operational tab. No credentials, operational flows,
MQTT brokers, adapters, or intervention notifications are included.

## Safety defaults

- `settings.js` binds Node-RED to `127.0.0.1:1882` and disables the admin/editor
  HTTP root. The only page is `/cpslai3-browse`.
- The flow contains only HTTP In, Function, and HTTP Response nodes. There are
  no Inject, OPC UA, MQTT, or startup-trigger nodes.
- Loading the runner creates no OPC UA client. The client and session are
  constructed only by a manual POST after the process arm and exact UI
  confirmation phrase both pass.
- The runtime arm is absent by default. Do not set it until an authorized LAI
  window has been approved. The page requires the operator to type the phrase
  `AUTHORIZE CPS-LAI-03 BROWSE` for every run.
- Security mode and policy are never negotiated or inferred. Set
  `CPSLAI3_BROWSE_SECURITY_MODE`, `CPSLAI3_BROWSE_SECURITY_POLICY`, and
  `CPSLAI3_BROWSE_SECURITY_CONFIRMATION` explicitly for the approved endpoint.
  `None/None` is only a candidate based on the operational adapter and must be
  verified with the LAI/controls owner before use. To confirm that candidate,
  the confirmation value must be exactly `CONFIRM CPS-LAI-03 OPC UA SECURITY
  None/None`. Without a recognized mode/policy pair and matching confirmation,
  Start is rejected before client construction. No security fallback exists.
- The runner calls the existing `lib/opcua/cpsLai3BrowseCatalog.mjs`, wraps the
  real session to expose only `browse()`/`browseNext()` to traversal, disables
  session keep-alive, and sets finite NodeOPCUA transport/transaction timeouts.
- The default endpoint is `opc.tcp://192.168.1.30:4840`; this is configuration
  only. It is not contacted by tests or by loading Node-RED.
- Results go only to this userDir's `results/`; fresh certificates/PKI, if
  needed by node-opcua, go under this userDir's `pki/`. Neither directory
  contains copied operational credentials. Both are excluded by `.gitignore`.
- `runner-state.json` is an exclusive safety journal. A durable active-run
  marker is written before connection; a restart with an active marker, an
  unreadable state file, or uncertain session cleanup enters persistent
  `BLOCKED`. Start, Cancel, and process initialization never clear that block.

## Future start procedure (not executed)

1. Obtain operational approval for the experimental connection; independently
   confirm the endpoint's exact security mode/policy and server session
   capacity. Do not assume `None/None` from the candidate setting.
2. Open PowerShell in the project root and set the arm only for that process:

   ```powershell
   $env:CPSLAI3_BROWSE_ARM = 'AUTHORIZE CPS-LAI-03 BROWSE'
   node .\node-red\lai\node_modules\node-red\red.js `
     --userDir .\node-red\lai\cpslai3-browse-instance `
     --settings .\node-red\lai\cpslai3-browse-instance\settings.js `
     --port 1882
   ```

   Set the three security variables only after approval. For a confirmed
   None/None endpoint, set mode `None`, policy `None`, and confirmation exactly
   `CONFIRM CPS-LAI-03 OPC UA SECURITY None/None`. Do not set the arm or run
   this command during implementation/test work.
3. Browse to `http://localhost:1882/cpslai3-browse`, verify status is `armed ·
   idle`, then manually type the confirmation phrase and click Start. Without
   the process arm, Start is rejected before client creation.
4. Monitor the page until completion/cancellation; download the JSON and JSONL
   from the page. Confirm files are under the experimental `results/` folder.
5. Stop the experimental Node-RED from its owning terminal with Ctrl+C. Verify
   the process and port 1882 have exited and no connection to port 4840 remains.
   Before restoring any operational service, independently verify with the
   server/operator diagnostics that the OPC UA session is closed.
6. If status is BLOCKED (including after an unexpected process exit), do not
   restart the discovery. First obtain external evidence that the session was
   closed: record the server-side session/diagnostic reference, timestamp, and
   confirmation from the authorized operator. On the loopback UI, use the
   separate “Supervised BLOCKED release” form and provide operator, a specific
   justification, and that external evidence. This writes an audit entry in
   `runner-state.json`; it is not Start authorization. If the state file is
   unreadable, keep the instance disarmed. The supervised release first
   preserves it as `runner-state.json.corrupt-*`; if preservation or journal
   writing fails, release is rejected. Do not delete/reset the state file
   manually.
7. Remove the arm and security-confirmation variables from that PowerShell
   session. Do not Deploy/import
   these flows into the operational instance.

## Lifecycle and limitations

The runner writes its active marker before any client allocation and updates
the stage as it proceeds. It waits for an outstanding Browse promise to settle
before sending CloseSession and attempts client disconnect in `finally`. A
failed CloseSession, unsettled Browse, uncertain CreateSession, failed safety
journal write, or restart with an active marker permanently blocks Start until
the explicit supervised release is recorded. The server may retain a session
until its timeout; external server/operator evidence is required before
release. A corrupt/unreadable state file also fails closed. The audit journal
is `runner-state.json`; do not edit or remove it to unblock the runner.

`httpAdminRoot` is disabled by design, so flow edits require stopping the
experimental process and editing its own `flows.json` offline. Node-RED and
node-opcua runtime packages are reused from the existing local installation,
but the Node-RED userDir, flows, context, PKI and results are separate. Do not
run this userDir until the endpoint's security configuration and the control
system's concurrent-session policy are approved.
