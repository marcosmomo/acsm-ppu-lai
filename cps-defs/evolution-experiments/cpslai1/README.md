# AVM-1B — AAS experimentais do CPS-LAI-01

`aas-v1.json` é uma baseline experimental enriquecida, e não uma cópia byte a byte da AAS oficial. Ela preserva a AAS oficial e acrescenta somente a declaração funcional experimental `Capabilities/PieceDetection`.

Os valores booleanos internos de `PieceDetection` representam suporte funcional declarado. Eles não representam estados instantâneos dos sensores e não constituem evidência de validação física.

- V1: `PieceAtEntry`, `PieceAtMiddle` e `PieceAtExit` declarados como suportados.
- V2: somente `PieceAtMiddle` muda de `true` para `false`.
- V3: preserva V2 e adiciona `ExperimentalAdaptivePieceDetection`, uma capacidade sintética, declarativa e não validada fisicamente.

As URNs em `semanticId` pertencem ao vocabulário experimental interno da UFSC/LAI e não alegam classificação ECLASS oficial.
