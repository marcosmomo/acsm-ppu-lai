# AVM-2 — Catálogo e seleção experimental de AAS

O catálogo AVM-2 contém exclusivamente `cpslai1` e as versões explícitas `v1`, `v2` e `v3`. Não existe seleção automática da versão numericamente mais alta. Cada entrada registra caminho permitido, identidade AAS, Asset ID, SHA-256, descrição documental e origem `EXPERIMENTAL_STATIC_DOCUMENT`.

## Contrato de seleção

Uma seleção aceita contém `cpsId`, `plugEventId`, `plugCycleId`, `profileId`, `aasVersion`, `aasSha256` e `selectionId`. A requisição sem `plugCycleId` ou `profileId` é persistida como `PENDING`, com `selectionId: null`; nenhum identificador é inventado. Quando ambos são informados pelo orquestrador simulado, a seleção passa a `SELECTED` e fica imutável.

Retry com todos os campos idênticos retorna `NO_OP`. Para o mesmo evento, divergência de versão, hash, ciclo ou perfil retorna `EXPERIMENTAL_SELECTION_CONFLICT`.

## Fronteiras

O resolver recalcula o hash, valida AAS ID e Asset ID, restringe o caminho à raiz injetada e verifica o caminho real para impedir escape por symlink. Ele preserva os bytes originais e produz metadados de proveniência não operacional. Seleção não contém resultado Evolution pré-calculado; a comparação ocorre posteriormente, usando os módulos Evolution existentes.

Para um teste visual futuro, a interface deverá obter as versões do catálogo, exigir escolha explícita, receber do orquestrador simulado os identificadores efetivos de ciclo e perfil, registrar a seleção no Store experimental e só então executar o fluxo offline de archive/snapshot. A interface deve mostrar versão, SHA-256, origem experimental e ausência de comprovação física.
