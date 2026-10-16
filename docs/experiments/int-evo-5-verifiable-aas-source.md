# INT-EVO-5 — Verifiable AAS document source

The module `lib/evolution/verifiableAasDocumentSource.mjs` resolves only an
explicit `referenceId` registered in a server-owned allowlist. Request data can
confirm `cpsId`, `aasId`, `assetId`, and `contentHash`, but cannot select a path,
change provenance, or override the hash calculated from server-read bytes.

The read-only projection contract is `verifiable-aas-projection/1.0`:

```text
cpsId, aasId, assetId, contentHash, version, administration,
sourceId, sourceType, operational, evidenceLevel, completeness,
functionalHash, capabilities, services, archiveReference,
physicalStateInferred=false
```

`version` is the authorized catalog version (`v1`, `v2`, `v3` in AVM). The
document's own administration version and revision are preserved separately in
`administration`, avoiding any claim that the AVM alias came from the AAS field.

Capabilities and services are produced by the existing functional normalizer,
which delegates extraction to the existing functional extractor. Instantaneous
operational data is not projected as a capability.

For a future Plug/Replug, resolve the allowlisted reference before lifecycle
mutation, verify and optionally archive its original bytes, and carry the frozen
`referenceId + contentHash + aasId + assetId` into the authoritative cycle
transaction. The functional projection may be published read-only only after
the Plug is accepted and correlated with `plugEventId`, `plugCycleId`, and
`profileId`.

Experimental AVM references must remain `sourceType=EXPERIMENTAL_STATIC_DOCUMENT`
and `operational=false`. Production activation requires a separate operational
catalog and source authority; the module does not promote experimental data.

Manual browser loading is deliberately not implemented. A safe future flow
requires a size-limited authenticated upload endpoint, server-side parsing and
validation, quarantine, content-addressed archival, and issuance of a server
owned `referenceId`. Browser-provided paths, hashes, identities, and provenance
must never become authoritative by themselves.
