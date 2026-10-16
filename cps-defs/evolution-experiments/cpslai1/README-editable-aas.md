# Editable experimental AAS

`editable-aas.json` is a working copy of the official CPS-LAI-01 AAS created for
the supervised card demonstration. It preserves the official AAS ID and Asset
ID, starts with the five official capabilities, and is not an operational AAS
source.

Edit this copy in VS Code and use **Refresh AAS** in the experimental area of
the existing card. Do not replace the official document or use this copy in a
PPU cycle.

To add `PieceDetection`, add a capability property or collection under the
`Capabilities.submodelElements` array. Stable semantic identities are
recommended for collections so the existing comparator can distinguish an
addition from a rename or relocation.
