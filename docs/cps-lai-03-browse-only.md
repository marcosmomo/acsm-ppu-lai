# CPS-LAI-03 Browse-only catalogue (offline implementation)

`lib/opcua/cpsLai3BrowseCatalog.mjs` is an independent traversal module. It does
not import `node-opcua`, create a client, or own a connection. It accepts a
session-like object and uses only `browse()` and `browseNext()` while exploring.
`createBrowseOnlyFacade(session)` exposes exactly those two methods, even when
the underlying `node-opcua` session supports other OPC UA services.

The current roots are the previously identified structural candidates
`Inputs`, `Outputs`, `Memory`, `PLC`, `DataBlocksGlobal`, and
`DataBlocksInstance` in namespace 3. They are candidates, not guarantees that
the server exposes them. The traversal is forward-only over Hierarchical
References and starts each configured root at depth zero.

Default bounds: depth 6, 5,000 unique NodeIds, 10 MiB serialized JSON, two
minutes, 100 requested references per Browse result, 10,000 Browse service
requests, 64 paths per NodeId, 500 errors, and a 5-second per-request guard.
The caller must also configure the underlying node-opcua transport/transaction
timeout: a JavaScript timeout cannot cancel a UA request already sent. When a
request remains unsettled, the result marks `sessionCloseRequired`; the owner
must close the session/client before reusing that connection. No concurrent
BrowseNext is issued against an unsettled request.

The result contains a JSON document and JSONL rows. Fields are structural
Browse metadata only: NodeId, BrowseName, DisplayName, NodeClass, parent,
hierarchical path, reference type/direction, and type definition when returned.
DataType and Value are intentionally absent because obtaining those requires
additional OPC UA services. Continuation point bytes and connection credentials
are never serialized. If a stop condition leaves a continuation point, the
module tries BrowseNext with `releaseContinuationPoints=true`; errors are
recorded without dumping the point.

## Future isolated Node-RED integration

Do not place this in the operational `CPS3LAI` tab or connect it to the
1881 adapter. In a separately configured 1882 userDir, a future dedicated
runner may create one `node-opcua` client/session, wrap the session with
`createBrowseOnlyFacade(session)`, call `discoverCpsLai3BrowseCatalog()`, persist
the returned JSON/JSONL, then close the session and disconnect in `finally`.
The runner must expose only Browse/BrowseNext to the exploration path and must
close the owner session/client if `sessionCloseRequired` is true. Do not reuse
the installed `OpcUa-Browser` node: its installed implementation performs
`session.read(... AttributeIds.Value)` for returned references.

## Offline verification

`test/cps-lai-03-browse-catalog.test.mjs` supplies in-memory session mocks. The
mock records every service call and throws if Read, Write, Call, or Subscribe is
invoked. These tests do not instantiate Node-RED, node-opcua clients, sockets,
or connect to the LAI network.
